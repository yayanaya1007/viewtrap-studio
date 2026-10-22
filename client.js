(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const readStoredJSON = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      if (value == null) return fallback;
      const parsed = JSON.parse(value);
      if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
      if (fallback && typeof fallback === "object") return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
      return parsed;
    } catch {
      return fallback;
    }
  };
  const state = { view: "videos", query: "", items: [], channels: [], trackedChannels: readStoredJSON("viewtrap.trackedChannels", {}), analysisChannels: readStoredJSON("viewtrap.analysisChannels", {}), channelSnapshots: readStoredJSON("viewtrap.channelSnapshots", {}), trackedLoading: false, channel: null, analysis: null, channelVideos: [], channelVideoToken: null, channelVideoTotal: 0, channelVideosLoading: false, channelDetails: null, hiddenVideos: new Set(readStoredJSON("viewtrap.hiddenVideos", [])), hiddenChannels: new Set(readStoredJSON("viewtrap.hiddenChannels", [])), keywords: [], proPlan: null, proError: null, proLoading: false, thumbnailLoading: false, thumbnailImages: [], snapshots: readStoredJSON("viewtrap.snapshots", {}), savedData: readStoredJSON("viewtrap.savedData", {}), folders: readStoredJSON("viewtrap.folders", ["기본"]), activeFolder: "전체", loading: false, saved: new Set(readStoredJSON("viewtrap.saved", [])), status: { youtube: false, gemini: false } };
  let toastTimer;
  let savedRefreshing = false;
  let nextPageToken = null;
  let lastSearchType = "videos";
  let loadingMore = false;

  const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const compact = (value) => value == null ? "비공개" : new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const date = (value) => value ? new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value)) : "날짜 정보 없음";
  const daysAgo = (value) => Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));

  function recordSnapshots(items) {
    const now = Date.now();
    const snapshots = state.snapshots;
    for (const item of items) {
      const series = snapshots[item.id] || [];
      const last = series.at(-1);
      if (!last || now - last.at >= 60 * 60 * 1000) series.push({ at: now, views: item.views });
      else if (series.length) series[series.length - 1] = { at: last.at, views: item.views };
      const cutoff = now - 30 * 86400000;
      snapshots[item.id] = series.filter(point => point.at >= cutoff).slice(-31);
      const history = snapshots[item.id];
      const first = history[0], latest = history.at(-1);
      item.observedViewsPerDay = history.length > 1 && latest.at > first.at
        ? Math.max(0, Math.round((latest.views - first.views) / ((latest.at - first.at) / 86400000)))
        : null;
      item.observedSeries = history;
    }
    const keys = Object.keys(snapshots);
    for (const key of keys.slice(0, Math.max(0, keys.length - 300))) delete snapshots[key];
    state.snapshots = snapshots;
    localStorage.setItem("viewtrap.snapshots", JSON.stringify(snapshots));
  }

  function recordChannelSnapshots(items) {
    const now = Date.now();
    for (const channel of items) {
      const series = state.channelSnapshots[channel.id] || [];
      const previous = series.at(-1);
      const current = { at: now, views: channel.views, subscribers: channel.subscribers, videos: channel.videos };
      if (!previous || now - previous.at >= 60 * 60 * 1000) series.push(current);
      else series[series.length - 1] = current;
      const cutoff = now - 90 * 86400000;
      state.channelSnapshots[channel.id] = series.filter(point => point.at >= cutoff).slice(-91);
      const first = state.channelSnapshots[channel.id][0];
      channel.observedViewsDelta = previous ? channel.views - previous.views : null;
      channel.observedSubscribersDelta = previous && previous.subscribers != null && channel.subscribers != null ? channel.subscribers - previous.subscribers : null;
      channel.observedViewsPerDay = first && now > first.at ? Math.round((channel.views - first.views) / ((now - first.at) / 86400000)) : null;
      channel.observedSubscriberGrowthPerDay = first && now > first.at && channel.subscribers != null && first.subscribers != null ? Math.round((channel.subscribers - first.subscribers) / ((now - first.at) / 86400000)) : null;
      channel.observedSeries = state.channelSnapshots[channel.id];
    }
    localStorage.setItem("viewtrap.channelSnapshots", JSON.stringify(state.channelSnapshots));
  }

  function addTrackedChannel(channel) {
    if (state.trackedChannels[channel.id]) { toast("이미 내 채널에 등록되어 있어요."); return; }
    const { uploadsPlaylist, ...saved } = channel;
    state.trackedChannels[channel.id] = { ...saved, addedAt: Date.now() };
    localStorage.setItem("viewtrap.trackedChannels", JSON.stringify(state.trackedChannels));
    toast("내 채널에 등록했어요.");
    renderChannels();
  }

  function exposureEstimate(item) {
    const subscribers = Number(item.subscriberCount || 0);
    const viewRatio = subscribers > 0 ? item.views / subscribers : 0;
    const ratioScore = Math.min(1, Math.log1p(viewRatio) / Math.log(4));
    const paceScore = Math.min(1, Math.log1p(item.viewsPerDay || 0) / Math.log1p(10000));
    const observed = item.observedViewsPerDay == null ? 0.35 : Math.min(1, Math.log1p(item.observedViewsPerDay) / Math.log1p(10000));
    const engagementScore = Math.min(1, (item.likeRate || 0) / 5);
    return Math.round(100 * (ratioScore * 0.35 + paceScore * 0.25 + observed * 0.25 + engagementScore * 0.15));
  }

  function channelContactEntries(description = "") {
    const text = String(description || "");
    const emails = [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])].slice(0, 5);
    const urls = [...new Set((text.match(/https?:\/\/[^\s<>"'`]+/gi) || []).map(value => value.replace(/[),.;!?]+$/, "")))].filter(value => {
      try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !/(youtube\.com|youtu\.be)/i.test(url.hostname); } catch { return false; }
    }).slice(0, 8);
    return { emails, urls };
  }

  function openPublicContacts(item) {
    if (!item) return;
    const contact = channelContactEntries(item.channelDescription || item.description || "");
    const channelUrl = item.channelUrl || item.url || "";
    const lines = [
      ...contact.emails.map(email => `<li><a href="mailto:${escapeHTML(email)}">${escapeHTML(email)}</a></li>`),
      ...contact.urls.map(url => `<li><a href="${escapeHTML(url)}" target="_blank" rel="noopener">${escapeHTML(url)}</a></li>`),
    ];
    $("#modalTitle").textContent = `${item.channelTitle || item.title || "채널"} · 공개 연락처`;
    $("#modalBody").innerHTML = `<p>채널 설명란에 공개된 이메일과 외부 링크를 모았습니다. 광고 문의는 채널이 공개한 연락처로 직접 보내세요.</p>${lines.length ? `<ul class="public-contact-list">${lines.join("")}</ul>` : `<div class="empty"><strong>설명란에 공개 연락처가 없습니다</strong>채널에서 연락처를 공개하지 않았거나 설명란에 포함하지 않았습니다.</div>`}<p><a class="channel-action" href="${escapeHTML(channelUrl)}" target="_blank" rel="noopener">YouTube 채널 열기 ↗</a></p>`;
    $("#modal").classList.add("show");
  }

  async function openChannelDetails(channel) {
    if (!channel) return;
    $("#modalTitle").textContent = `${channel.title} · 채널 트렌드`;
    $("#modalBody").innerHTML = loadingCard("채널 통계와 최근 업로드를 불러오는 중...");
    $("#modal").classList.add("show");
    try {
      const data = await api("/api/channel-details", { channelId: channel.id });
      const recent = data.videos || [];
      const maxViews = Math.max(1, ...recent.map(video => video.views));
      $("#modalBody").innerHTML = `<div class="modal-metrics"><div class="metric"><div class="metric-label">구독자</div><div class="metric-value">${compact(channel.subscribers)}</div></div><div class="metric"><div class="metric-label">누적 조회</div><div class="metric-value">${compact(channel.views)}</div></div><div class="metric"><div class="metric-label">전체 영상</div><div class="metric-value">${compact(channel.videos)}</div></div></div><section class="video-history"><h4>최근 업로드 성과</h4>${recent.map(video => `<div class="trend"><span class="trend-text">${escapeHTML(video.title)}</span><span class="trend-growth">${compact(video.views)} 조회 · ${compact(video.viewsPerDay)}/일 평균</span><i class="trend-bar" style="width:${Math.max(4, Math.round(video.views/maxViews*100))}%"></i></div>`).join("") || "<p>최근 공개 영상이 없습니다.</p>"}</section><p class="notice">조회수/일은 누적 조회수를 게시 후 경과 일수로 나눈 값입니다. 서로 다른 업로드 날짜와 영상 길이의 영향을 받으며, 실제 노출 수는 아닙니다.</p><button class="channel-action" id="modalContact" type="button">공개 연락처 모으기</button>`;
      $("#modalContact")?.addEventListener("click", () => openPublicContacts({ ...channel, description: data.channel?.description }));
    } catch (error) {
      $("#modalBody").innerHTML = errorCard(error);
    }
  }

  function recordHidden(kind, id) {
    const set = kind === "channel" ? state.hiddenChannels : state.hiddenVideos;
    set.add(id);
    localStorage.setItem(kind === "channel" ? "viewtrap.hiddenChannels" : "viewtrap.hiddenVideos", JSON.stringify([...set]));
    toast(kind === "channel" ? "이 채널을 검색 결과에서 제외했습니다." : "이 영상을 검색 결과에서 제외했습니다.");
    render();
  }

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2400);
  }

  async function api(path, body) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.message || "요청을 처리하지 못했습니다."), { code: result.code || "request_failed" });
    return result;
  }

  async function refreshStatus() {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      state.status = await response.json();
    } catch {
      state.status = { youtube: false, gemini: false };
    }
    const missing = [];
    if (!state.status.youtube) missing.push("YouTube Data API 키");
    if (!state.status.gemini) missing.push("Gemini API 키");
    $("#integrationNotice").hidden = missing.length === 0;
    $("#youtubeStatus").textContent = state.status.youtube ? "YouTube 연결됨" : "YouTube 키 필요";
    $("#youtubeStatus").className = state.status.youtube ? "connected" : "missing";
    $("#geminiStatus").textContent = state.status.gemini ? "Gemini 연결됨" : "Gemini 키 필요";
    $("#geminiStatus").className = state.status.gemini ? "connected" : "missing";
    if (missing.length) {
      $("#integrationTitle").textContent = "실시간 데이터 연결을 마무리해 주세요";
      $("#integrationMessage").textContent = `${missing.join("과 ")}를 Sites의 런타임 Secrets에 등록하면 이 화면에서 실제 검색과 AI 분석이 동작합니다. 키는 브라우저에 노출되지 않습니다.`;
    }
  }

  function loadingCard(message) {
    return `<div class="loading" role="status">${escapeHTML(message)}</div>`;
  }

  function errorCard(error) {
    const hint = error.code === "youtube_key_missing" ? "먼저 YouTube Data API 키를 등록해 주세요." : error.code === "gemini_key_missing" ? "Gemini 키를 등록하면 추천과 채널 분석을 이용할 수 있어요." : "연결 설정을 확인하고 다시 시도해 주세요.";
    return `<div class="error-box"><b>${escapeHTML(error.message)}</b><br>${hint}<br><a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube API 설정 ↗</a> &nbsp; <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Gemini API 키 ↗</a></div>`;
  }

  function renderMetrics() {
    const items = state.items;
    const totalViews = items.reduce((sum, item) => sum + item.views, 0);
    const averagePace = items.length ? Math.round(items.reduce((sum, item) => sum + item.viewsPerDay, 0) / items.length) : 0;
    const metrics = state.view === "channels"
      ? [["검색 채널", `${state.channels.length}개`, "YouTube 공개 채널"], ["구독자", compact(state.channels.reduce((sum, item) => sum + (item.subscribers || 0), 0)), "표시 가능한 채널 합계"], ["누적 조회수", compact(state.channels.reduce((sum, item) => sum + item.views, 0)), "선택한 채널 합계"], ["추천 키워드", `${state.keywords.length}개`, "Gemini 제안"]]
      : state.view === "tracked"
        ? [["등록 채널", `${Object.keys(state.trackedChannels).length}개`, "이 브라우저에 저장"], ["채널 합산 조회수", compact(Object.values(state.trackedChannels).reduce((sum, item) => sum + (item.views || 0), 0)), "현재 공개 통계"], ["관측 채널", `${Object.values(state.channelSnapshots).filter(series => series.length > 1).length}개`, "두 번 이상 갱신"], ["폴더", `${state.folders.length}개`, "저장 영상 분류"]]
        : [["검색 영상", `${items.length}개`, "YouTube 검색 결과"], ["누적 조회수", compact(totalViews), "현재 결과 기준"], ["평균 일 조회수", compact(averagePace), "업로드 후 누적 기준 추정"], ["저장한 영상", `${state.saved.size}개`, "이 브라우저에 저장"]];
    $("#metrics").innerHTML = metrics.map(([label, value, foot]) => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></div>`).join("");
  }

  function renderKeywords() {
    const host = $("#keywords");
    if (!state.status.gemini) {
      host.innerHTML = `<div class="metric-unavailable">Gemini 키를 등록하면 검색 주제에 맞는 키워드를 제안합니다.</div>`;
      return;
    }
    if (!state.keywords.length) {
      host.innerHTML = `<div class="metric-unavailable">검색 후 Gemini 키워드 제안을 불러옵니다.</div>`;
      return;
    }
    host.innerHTML = state.keywords.map((word) => `<button class="keyword-item" type="button" data-keyword="${escapeHTML(word)}"><b>${escapeHTML(word)}</b><em>검색</em></button>`).join("");
    $$("[data-keyword]").forEach((button) => button.addEventListener("click", () => {
      $("#query").value = button.dataset.keyword;
      $("#query").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }));
  }

  function addLoadMoreButton() {
    if (!nextPageToken || state.loading) return;
    $("#results").insertAdjacentHTML("beforeend", `<div class="load-more-wrap"><button class="channel-action" id="loadMoreResults" type="button" ${loadingMore ? "disabled" : ""}>${loadingMore ? "불러오는 중…" : "더 불러오기"}</button></div>`);
    $("#loadMoreResults")?.addEventListener("click", loadMoreResults);
  }

  async function loadMoreResults() {
    if (!nextPageToken || loadingMore) return;
    const pageToken = nextPageToken;
    loadingMore = true;
    render();
    try {
      const result = await api("/api/search", { type: lastSearchType, query: state.query, limit: 50, pageToken, regionCode: $("#regionSelect").value, publishedAfter: lastSearchType === "videos" ? publishedAfter() : undefined });
      nextPageToken = result.nextPageToken || null;
      if (lastSearchType === "videos") { const added = result.items || []; recordSnapshots(added); state.items = [...state.items, ...added]; }
      else { const added = result.items || []; recordChannelSnapshots(added); state.channels = [...state.channels, ...added]; }
    } catch (error) { toast(error.message); }
    finally { loadingMore = false; render(); }
  }

  function renderVideos() {
    let items = state.items.filter(item => !state.hiddenVideos.has(item.id));
    const minViews = $("#filterViews").value === "all" ? 0 : Number($("#filterViews").value || 0);
    const minSubs = Number($("#filterSubs")?.value || 0);
    const sort = $("#sortBy").value;
    const minLikes = Number($("#filterLikes")?.value || 0);
    const minContribution = Number($("#filterContribution")?.value || 0);
    items = items.filter((item) => item.views >= minViews && item.likes >= minLikes && Number(item.subscriberCount || 0) >= minSubs && (minContribution === 0 || (item.subscriberCount > 0 && item.views / item.subscriberCount >= minContribution)));
    items.sort((a, b) => sort === "growth" ? (b.observedViewsPerDay ?? -1) - (a.observedViewsPerDay ?? -1) : sort === "chance" ? exposureEstimate(b) - exposureEstimate(a) : sort === "contribution" ? (b.subscriberCount ? b.views / b.subscriberCount : -1) - (a.subscriberCount ? a.views / a.subscriberCount : -1) : b.views - a.views);
    $("#resultTitle").innerHTML = `YouTube 영상 <span>${state.query ? `“${escapeHTML(state.query)}” 검색 결과` : "검색어를 입력해 시작하세요"}</span>`;
    if (state.loading) $("#results").innerHTML = loadingCard("YouTube에서 최신 공개 데이터를 불러오는 중...");
    else if (!items.length) $("#results").innerHTML = `<div class="empty"><strong>${state.query ? "검색 결과가 없어요" : "검색어를 입력해 주세요"}</strong>검색어를 입력하면 YouTube에서 실제 영상을 찾아옵니다.</div>`;
    else $("#results").innerHTML = items.map((item) => `<article class="video-card"><a class="thumb video-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener" aria-label="YouTube에서 영상 보기" style="background-image:url('${escapeHTML(item.thumbnail)}');background-size:cover;background-position:center"><span class="duration">${escapeHTML(item.duration)}</span></a><div class="video-copy"><h3 class="video-title"><a class="video-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener">${escapeHTML(item.title)}</a></h3><div class="channel-line"><span class="channel-avatar">${escapeHTML(item.channelTitle.slice(0, 1))}</span>${escapeHTML(item.channelTitle)} · 구독자 ${compact(item.subscriberCount)}</div><div class="video-stats"><span>조회수 <b>${compact(item.views)}</b></span><span>좋아요 <b>${compact(item.likes)}</b></span><span>${item.subscriberCount ? `구독자 대비 ${Math.round(item.views / item.subscriberCount * 100)}%` : "구독자 비공개"}</span><span>${date(item.publishedAt)}</span></div></div><div class="card-right"><div class="chance">노출 관심지수<strong>${exposureEstimate(item)}점</strong></div><div class="chance-bar"><i style="width:${exposureEstimate(item)}%"></i></div><div class="delta">${item.observedViewsPerDay == null ? "추이 관측 대기" : `관측 +${compact(item.observedViewsPerDay)}/일`}</div><div class="video-actions"><button class="detail-btn" type="button" data-detail="${escapeHTML(item.id)}">상세 보기</button><button class="channel-action" type="button" data-contact-video="${escapeHTML(item.id)}">연락처 수집</button><button class="channel-action remove-track" type="button" data-hide-video="${escapeHTML(item.id)}">영상 제외</button></div></div></article>`).join("");
    $$("[data-detail]").forEach((button) => button.addEventListener("click", () => openVideo(state.items.find((item) => item.id === button.dataset.detail))));
    $$('[data-contact-video]').forEach(button => button.addEventListener("click", () => openPublicContacts(state.items.find(item => item.id === button.dataset.contactVideo))));
    $$('[data-hide-video]').forEach(button => button.addEventListener("click", () => recordHidden("video", button.dataset.hideVideo)));
    addLoadMoreButton();
    renderMetrics();
  }

  function renderChannels() {
    $("#resultTitle").innerHTML = `YouTube 채널 <span>${state.query ? `“${escapeHTML(state.query)}” 검색 결과` : "검색어를 입력해 시작하세요"}</span>`;
    const minSubs = Number($("#filterChannelSubs")?.value || 0);
    const minViews = Number($("#filterChannelViews")?.value || 0);
    const minVideos = Number($("#filterChannelVideos")?.value || 0);
    const sort = $("#sortChannels")?.value || "subscribers";
    const channels = state.channels.filter(channel => !state.hiddenChannels.has(channel.id) && (channel.subscribers || 0) >= minSubs && channel.views >= minViews && channel.videos >= minVideos);
    channels.sort((a,b) => sort === "views" ? b.views-a.views : sort === "videos" ? b.videos-a.videos : sort === "growth" ? (b.observedViewsPerDay ?? -1)-(a.observedViewsPerDay ?? -1) : sort === "efficiency" ? (b.views/Math.max(1,b.videos))-(a.views/Math.max(1,a.videos)) : (b.subscribers || 0)-(a.subscribers || 0));
    if (state.loading) $("#results").innerHTML = loadingCard("YouTube에서 채널 정보를 불러오는 중...");
    else if (!channels.length) $("#results").innerHTML = `<div class="empty"><strong>${state.query ? "검색 결과가 없어요" : "채널 검색을 시작해 보세요"}</strong>${state.hiddenChannels.size ? "제외한 채널은 ‘제외 초기화’로 다시 표시할 수 있어요." : "채널명이나 주제를 검색하면 YouTube의 공개 채널을 찾아옵니다."}</div>`;
    else $("#results").innerHTML = `<div class="channel-results">${channels.map((channel) => `<article class="channel-card"><div class="channel-big">${channel.thumbnail ? `<img src="${escapeHTML(channel.thumbnail)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : escapeHTML(channel.title.slice(0, 1))}</div><div class="channel-info"><b>${escapeHTML(channel.title)}</b><p>${escapeHTML(channel.description.slice(0, 110))}</p><div class="channel-meta"><span>구독자 ${compact(channel.subscribers)}</span><span>동영상 ${compact(channel.videos)}</span><span>누적 조회수 ${compact(channel.views)}</span><span>영상당 조회수 ${compact(channel.views / Math.max(1,channel.videos))}</span><span>${channel.observedViewsPerDay == null ? "성장 추이 관측 대기" : `일 조회 ${channel.observedViewsPerDay >= 0 ? "+" : ""}${compact(channel.observedViewsPerDay)}`}</span></div></div><div class="channel-actions"><a class="channel-action" href="${escapeHTML(channel.url)}" target="_blank" rel="noopener">채널 보기</a><button class="channel-action" type="button" data-channel-detail="${escapeHTML(channel.id)}">상세 데이터</button><button class="channel-action" type="button" data-contact-channel="${escapeHTML(channel.id)}">연락처 수집</button><button class="channel-action" type="button" data-analyze="${escapeHTML(channel.id)}">채널 분석에 추가</button><button class="channel-action" type="button" data-track-channel="${escapeHTML(channel.id)}" ${state.trackedChannels[channel.id] ? "disabled" : ""}>${state.trackedChannels[channel.id] ? "추적 중" : "채널 추적"}</button><button class="channel-action remove-track" type="button" data-hide-channel="${escapeHTML(channel.id)}">채널 제외</button></div></article>`).join("")}</div>`;
    $$("[data-analyze]").forEach((button) => button.addEventListener("click", () => loadAnalysis(button.dataset.analyze)));
    $$('[data-channel-detail]').forEach(button => button.addEventListener("click", () => openChannelDetails(state.channels.find(item => item.id === button.dataset.channelDetail))));
    $$('[data-contact-channel]').forEach(button => button.addEventListener("click", () => openPublicContacts(state.channels.find(item => item.id === button.dataset.contactChannel))));
    $$('[data-track-channel]').forEach(button => button.addEventListener("click", () => { const channel = state.channels.find(item => item.id === button.dataset.trackChannel); if (channel) addTrackedChannel(channel); }));
    $$('[data-hide-channel]').forEach(button => button.addEventListener("click", () => recordHidden("channel", button.dataset.hideChannel)));
    addLoadMoreButton();
    renderMetrics();
  }

  function renderTrackedChannels() {
    const tracked = Object.values(state.trackedChannels);
    $("#resultTitle").innerHTML = `내 채널 <span>${tracked.length}개 · 최근 갱신 시 공개 지표</span>`;
    if (!tracked.length) {
      $("#results").innerHTML = `<div class="empty"><strong>추적 중인 채널이 없습니다</strong>채널 찾기에서 채널을 검색한 뒤 “내 채널에 등록”을 눌러 주세요.</div>`;
      renderMetrics();
      return;
    }
    const refreshButton = `<button class="primary" id="refreshTracked" ${state.trackedLoading ? "disabled" : ""}>${state.trackedLoading ? "지표 갱신 중…" : "채널 지표 새로고침"}</button>`;
    $("#results").innerHTML = `<div class="tracked-head">${refreshButton}<p>등록한 채널의 공개 통계를 새로고침할 수 있습니다. 날짜별 변화는 이 브라우저에서 갱신한 기록으로 계산합니다.</p></div><div class="tracked-list">${tracked.map(channel => {
      const series = state.channelSnapshots[channel.id] || [];
      const latest = series.at(-1);
      const older = series.length > 1 ? series[0] : null;
      const max = Math.max(1, ...series.map(point => point.views));
      const bars = series.map(point => `<i style="height:${Math.max(5, Math.round(point.views / max * 100))}%" title="${date(point.at)} · ${compact(point.views)} 조회"></i>`).join("");
      return `<article class="tracked-card"><div class="tracked-logo">${channel.thumbnail ? `<img src="${escapeHTML(channel.thumbnail)}" alt="">` : escapeHTML((channel.title || "채널").slice(0,1))}</div><div class="tracked-copy"><h3>${escapeHTML(channel.title)}</h3><p>구독자 ${compact(channel.subscribers)} · 영상 ${compact(channel.videos)} · 누적 조회수 ${compact(channel.views)}</p><div class="tracked-deltas">${channel.observedViewsDelta == null ? "첫 지표 기록" : `최근 조회수 ${channel.observedViewsDelta >= 0 ? "+" : ""}${compact(channel.observedViewsDelta)}`} · ${channel.observedSubscribersDelta == null ? "구독자 변화 관측 대기" : `구독자 ${channel.observedSubscribersDelta >= 0 ? "+" : ""}${compact(channel.observedSubscribersDelta)}`}</div><div class="tracked-chart">${bars || "<span>새로고침하면 추이 기록이 시작됩니다.</span>"}</div><small>${latest ? `${date(latest.at)} 갱신${older ? ` · ${series.length}회 관측` : ""}` : "아직 새로고침하지 않았습니다."}</small></div><div class="tracked-actions"><button class="channel-action" type="button" data-track-analyze="${escapeHTML(channel.id)}">채널 분석</button><button class="channel-action remove-track" type="button" data-untrack="${escapeHTML(channel.id)}">등록 해제</button></div></article>`;
    }).join("")}</div>`;
    $("#refreshTracked")?.addEventListener("click", refreshTrackedChannels);
    $$('[data-track-analyze]').forEach(button => button.addEventListener("click", () => loadAnalysis(button.dataset.trackAnalyze)));
    $$('[data-untrack]').forEach(button => button.addEventListener("click", () => { delete state.trackedChannels[button.dataset.untrack]; localStorage.setItem("viewtrap.trackedChannels", JSON.stringify(state.trackedChannels)); renderTrackedChannels(); }));
    renderMetrics();
  }

  async function refreshTrackedChannels() {
    const channelIds = Object.keys(state.trackedChannels);
    if (!channelIds.length || state.trackedLoading) return;
    state.trackedLoading = true;
    renderTrackedChannels();
    try {
      const results = await Promise.all(Array.from({ length: Math.ceil(channelIds.length / 50) }, (_, index) => api("/api/tracked-channels", { channelIds: channelIds.slice(index * 50, (index + 1) * 50) })));
      const refreshed = results.flatMap(result => result.items || []);
      recordChannelSnapshots(refreshed);
      for (const channel of refreshed) state.trackedChannels[channel.id] = { ...state.trackedChannels[channel.id], ...channel, addedAt: state.trackedChannels[channel.id]?.addedAt || Date.now() };
      localStorage.setItem("viewtrap.trackedChannels", JSON.stringify(state.trackedChannels));
    } catch (error) { toast(error.message); }
    finally { state.trackedLoading = false; renderTrackedChannels(); }
  }

  function renderAnalysis() {
    if (!state.channel) {
      $("#resultTitle").innerHTML = `채널 분석 <span>분석할 채널을 검색하세요</span>`;
      const channels = Object.values(state.analysisChannels);
      $("#results").innerHTML = state.loading ? loadingCard("YouTube 채널을 검색하는 중...") : channels.length ? channels.map(channel => '<article class="tracked-card"><div class="tracked-copy"><h3>' + escapeHTML(channel.title) + '</h3><p>분석 보관함 · 등록 ' + date(channel.addedAt) + '</p></div><button class="channel-action" data-load-analysis="' + escapeHTML(channel.id) + '" type="button">영상 모아보기</button><button class="channel-action remove-track" data-remove-analysis="' + escapeHTML(channel.id) + '" type="button">목록에서 제거</button></article>').join("") + '<div class="empty"><strong>관심 채널 추가</strong>채널 찾기에서 “채널 분석에 추가”를 누르세요.</div>' : `<div class="empty"><strong>분석할 채널을 추가해 주세요</strong>채널 찾기에서 관심 채널의 “채널 분석에 추가”를 누르면 업로드 영상을 모아 볼 수 있어요.</div>`;
      $$("[data-load-analysis]").forEach(button => button.addEventListener("click", () => loadAnalysis(button.dataset.loadAnalysis)));
      $$("[data-remove-analysis]").forEach(button => button.addEventListener("click", () => { delete state.analysisChannels[button.dataset.removeAnalysis]; localStorage.setItem("viewtrap.analysisChannels", JSON.stringify(state.analysisChannels)); renderAnalysis(); }));
      renderMetrics();
      return;
    }
    const channel = state.channel;
    const analysis = state.analysis;
    $("#resultTitle").innerHTML = `${escapeHTML(channel.title)} <span>${analysis ? "YouTube 공개 지표 + Gemini 분석" : "분석 중"}</span>`;
    if (state.loading) {
      $("#results").innerHTML = loadingCard("공개 채널 지표를 가져와 Gemini가 분석하고 있어요...");
      return;
    }
    if (!analysis) {
      $("#results").innerHTML = `<div class="error-box">${escapeHTML(state.error || "분석을 불러오지 못했습니다.")}</div>`;
      if (state.channelVideos.length) {
        const list = state.channelVideos.slice(0, 100).map(video => '<a href="' + escapeHTML(video.url) + '" target="_blank" rel="noopener">' + escapeHTML(video.title) + ' <span>' + compact(video.views) + ' 조회</span></a>').join('');
        $('#results').insertAdjacentHTML('beforeend', '<section class="video-history"><h4>수집 영상 ' + state.channelVideos.length + '개 / 전체 공개 ' + (state.channelVideoTotal || channel.videos) + '개</h4>' + (state.channelVideoToken ? '<button class="channel-action" id="collectAllVideos" type="button">전체 업로드 수집</button>' : '<p>전체 업로드를 수집했습니다.</p>') + '<div class="collected-video-list">' + list + '</div></section>');
        $('#collectAllVideos')?.addEventListener('click', collectAllChannelVideos);
      }      return;
    }
    const recent = state.channelVideos.length ? state.channelVideos : analysis.recentVideos || [];
    const max = Math.max(1, ...recent.map((video) => video.views));
    $("#results").innerHTML = `<section class="analysis-card"><div class="analysis-top"><div class="analysis-logo">${channel.thumbnail ? `<img src="${escapeHTML(channel.thumbnail)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : escapeHTML(channel.title.slice(0, 1))}</div><div><h3>${escapeHTML(channel.title)}</h3><p>YouTube 공개 채널 · 최근 업로드 ${recent.length}개</p></div><a class="pill" href="${escapeHTML(channel.url)}" target="_blank" rel="noopener">YouTube에서 보기 ↗</a></div><div class="analysis-metrics"><div class="metric"><div class="metric-label">구독자</div><div class="metric-value">${compact(channel.subscribers)}</div><div class="metric-foot">공개 채널 통계</div></div><div class="metric"><div class="metric-label">총 조회수</div><div class="metric-value">${compact(channel.views)}</div><div class="metric-foot">공개 채널 통계</div></div><div class="metric"><div class="metric-label">영상 수</div><div class="metric-value">${compact(channel.videos)}</div><div class="metric-foot">전체 공개 수</div></div><div class="metric"><div class="metric-label">최근 영상 평균</div><div class="metric-value">${compact(recent.length ? Math.round(recent.reduce((sum, video) => sum + video.views, 0) / recent.length) : 0)}</div><div class="metric-foot">최근 ${recent.length}개 기준</div></div></div><div class="chart-wrap"><div class="chart-head">최근 업로드 영상 조회수 <span>현재 공개 누적 조회수 · 과거 성장 그래프가 아닙니다</span></div><div class="chart-bars">${recent.map((video) => `<div class="chart-bar" style="height:${Math.max(6, Math.round(video.views / max * 100))}%" title="${escapeHTML(video.title)} · ${compact(video.views)} 조회"><span>${date(video.publishedAt).slice(0, 7)}</span></div>`).join("")}</div></div><div class="analysis-copy">${escapeHTML(analysis.analysis)}</div><p class="notice">YouTube Data API의 공개 통계에는 노출 수와 시청 지속 시간, 과거 날짜별 조회수가 포함되지 않습니다. Gemini 요약은 이 화면에 표시된 공개 정보만 사용합니다.</p></section>`;
    $("#results").insertAdjacentHTML("beforeend", '<section class="video-history"><h4>모은 채널 영상 ' + state.channelVideos.length + '개 / 전체 공개 ' + (state.channelVideoTotal || channel.videos) + '개</h4>' + (state.channelVideoToken ? '<button class="channel-action" id="collectAllVideos" type="button" ' + (state.channelVideosLoading ? 'disabled' : '') + '>' + (state.channelVideosLoading ? '수집 중…' : '전체 업로드 수집') + '</button>' : '<p>전체 업로드를 수집했습니다.</p>') + '<div class="collected-video-list">' + state.channelVideos.slice(0, 100).map(video => '<a href="' + escapeHTML(video.url) + '" target="_blank" rel="noopener">' + escapeHTML(video.title) + ' <span>' + compact(video.views) + ' 조회 · ' + date(video.publishedAt) + '</span></a>').join('') + '</div></section>');
    $("#collectAllVideos")?.addEventListener("click", collectAllChannelVideos);
    $("#keywords").innerHTML = `<div class="metric-unavailable">채널 보고서에서 Gemini가 제안한 아이디어를 확인하세요.</div>`;
    renderMetrics();
  }

  async function collectAllChannelVideos() {
    if (state.channelVideosLoading || !state.channel || !state.channelVideoToken) return;
    state.channelVideosLoading = true;
    renderAnalysis();
    try {
      while (state.channelVideoToken) {
        const page = await api("/api/channel-videos", { channelId: state.channel.id, pageToken: state.channelVideoToken });
        const added = page.videos || [];
        recordSnapshots(added);
        state.channelVideos = [...state.channelVideos, ...added];
        state.channelVideoToken = page.nextPageToken || null;
        state.channelVideoTotal = page.totalResults || state.channelVideoTotal;
        renderAnalysis();
      }
      state.analysis = await api("/api/analyze", { channelId: state.channel.id, videos: state.channelVideos.slice(0, 100) });
      toast("전체 공개 업로드 " + state.channelVideos.length + "개를 모았습니다.");
    } catch (error) {
      state.error = error.message;
      toast(error.message + " · 지금까지 받은 영상은 목록에 남아 있습니다.");
    } finally {
      state.channelVideosLoading = false;
      renderAnalysis();
    }
  }

  function renderSaved() {
    const all = Object.values(state.savedData);
    const items = all.filter((item) => state.activeFolder === "전체" || item.folder === state.activeFolder);
    $("#resultTitle").innerHTML = `저장한 영상 <span>${items.length}개 · 폴더 ${state.folders.length}개</span>`;
    $("#folderCard").hidden = false;
    $("#folderList").innerHTML = ["전체", ...state.folders].map(folder => `<button class="folder-chip ${state.activeFolder === folder ? "active" : ""}" type="button" data-folder-filter="${escapeHTML(folder)}">${escapeHTML(folder)} <span>${folder === "전체" ? all.length : all.filter(item => item.folder === folder).length}</span></button>`).join("");
    $("#results").innerHTML = items.length ? items.map((item) => `<article class="video-card"><div class="video-copy"><h3 class="video-title"><a class="video-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener">${escapeHTML(item.title)}</a></h3><div class="channel-line">${escapeHTML(item.channelTitle)} · ${escapeHTML(item.folder || "기본")}</div><div class="video-stats"><span>조회수 <b>${compact(item.views)}</b></span></div></div><select class="folder-select" data-move-folder="${escapeHTML(item.id)}" aria-label="저장 폴더 이동">${state.folders.map(folder => `<option ${item.folder === folder ? "selected" : ""} value="${escapeHTML(folder)}">${escapeHTML(folder)}</option>`).join("")}</select><button class="detail-btn" type="button" data-remove="${escapeHTML(item.id)}">저장 취소</button></article>`).join("") : `<div class="empty"><strong>${all.length ? "이 폴더에 저장한 영상이 없습니다" : "저장한 영상이 없습니다"}</strong>YouTube 검색 결과에서 영상을 저장하고 폴더로 분류할 수 있어요.</div>`;
    $$("[data-folder-filter]").forEach((button) => button.addEventListener("click", () => { state.activeFolder = button.dataset.folderFilter; renderSaved(); }));
    if (all.length) {
      $("#results").insertAdjacentHTML("afterbegin", `<div class="tracked-head saved-refresh"><button class="primary" id="refreshSaved" ${savedRefreshing ? "disabled" : ""}>${savedRefreshing ? "영상 지표 갱신 중…" : "저장 영상 지표 새로고침"}</button><p>저장한 영상의 최신 조회수·좋아요를 가져와 이 브라우저의 관측 기록을 업데이트합니다.</p></div>`);
      $("#refreshSaved")?.addEventListener("click", refreshSavedVideos);
    }
    $$("[data-move-folder]").forEach((select) => select.addEventListener("change", () => { const item = state.savedData[select.dataset.moveFolder]; if (item) { item.folder = select.value; localStorage.setItem("viewtrap.savedData", JSON.stringify(state.savedData)); renderSaved(); } }));
    $$("[data-remove]").forEach((button) => button.addEventListener("click", () => { state.saved.delete(button.dataset.remove); delete state.savedData[button.dataset.remove]; localStorage.setItem("viewtrap.saved", JSON.stringify([...state.saved])); localStorage.setItem("viewtrap.savedData", JSON.stringify(state.savedData)); renderSaved(); renderMetrics(); }));
    $("#newFolder")?.addEventListener("click", () => { const name = window.prompt("새 폴더 이름"); const clean = String(name || "").trim().slice(0, 32); if (clean && !state.folders.includes(clean)) { state.folders.push(clean); localStorage.setItem("viewtrap.folders", JSON.stringify(state.folders)); state.activeFolder = clean; renderSaved(); } });
    renderMetrics();
  }

  async function refreshSavedVideos() {
    const videoIds = Object.keys(state.savedData);
    if (!videoIds.length || savedRefreshing) return;
    savedRefreshing = true;
    renderSaved();
    try {
      const results = await Promise.all(Array.from({ length: Math.ceil(videoIds.length / 50) }, (_, index) => api("/api/refresh-videos", { videoIds: videoIds.slice(index * 50, (index + 1) * 50) })));
      const refreshed = results.flatMap(result => result.items || []);
      recordSnapshots(refreshed);
      for (const video of refreshed) state.savedData[video.id] = { ...video, folder: state.savedData[video.id]?.folder || state.folders[0] || "기본" };
      localStorage.setItem("viewtrap.savedData", JSON.stringify(state.savedData));
      renderSaved();
    } catch (error) { toast(error.message); }
    finally { savedRefreshing = false; renderSaved(); }
  }

  function renderProfessional() {
    $("#resultTitle").innerHTML = `Professional 콘텐츠 팩 <span>${state.proPlan ? "AI 전략 보고서 · 제목·썸네일 기획 4세트" : "공개 지표 기반 심층 기획"}</span>`;
    if (state.proLoading) {
      $("#results").innerHTML = loadingCard("최근 영상 지표를 비교해 4개 콘텐츠 기획안을 만들고 있어요...");
      return;
    }
    if (state.proError) {
      $("#results").innerHTML = errorCard(state.proError);
      return;
    }
    if (!state.proPlan) {
      $("#results").innerHTML = `<div class="empty"><strong>Professional 콘텐츠 팩</strong>먼저 영상 검색을 한 뒤 버튼을 누르면 채널·영상 패턴, 실험 아이디어, 제목·썸네일 기획 4세트를 생성합니다. 영상 검색 ${state.items.length}개 저장됨.</div>`;
      return;
    }
    const plan = state.proPlan;
    const ideas = Array.isArray(plan.titleThumbnailIdeas) ? plan.titleThumbnailIdeas.slice(0, 4) : [];
    const images = state.thumbnailImages;
    $("#results").innerHTML = `<section class="analysis-card professional-card"><div class="pro-heading"><div><p class="eyebrow">PROFESSIONAL CREATIVE PACK</p><h3>콘텐츠 전략 보고서</h3><p>${escapeHTML(state.query || "검색 주제")} · 공개 자료 ${state.items.length}개</p></div><button class="primary pro-image-button" id="generateThumbs" ${state.thumbnailLoading ? "disabled" : ""}>${state.thumbnailLoading ? "썸네일 생성 중…" : "썸네일 이미지 4장 생성 · 약 $0.07"}</button></div><p class="pro-summary">${escapeHTML(plan.executiveSummary || "")}</p><div class="pro-columns"><section><h4>시청자 가설</h4><ul>${(plan.audienceHypotheses || []).map(x => `<li>${escapeHTML(x)}</li>`).join("")}</ul></section><section><h4>반복 패턴</h4><ul>${(plan.patterns || []).map(x => `<li>${escapeHTML(x)}</li>`).join("")}</ul></section><section><h4>다음 실험</h4><ul>${(plan.experiments || []).map(x => `<li>${escapeHTML(x)}</li>`).join("")}</ul></section></div><h4 class="pro-section-title">제목·썸네일 기획 4세트</h4><div class="pro-ideas">${ideas.map((idea, i) => `<article class="pro-idea"><div class="pro-idea-art">${images[i] ? `<img src="data:${escapeHTML(images[i].mimeType)};base64,${images[i].data}" alt="${escapeHTML(idea.title)} 썸네일 배경">` : `<div class="thumb-brief"><b>${escapeHTML(idea.thumbnailText || "썸네일 문구")}</b><span>${escapeHTML(idea.visualBrief || "")}</span></div>`}</div><div class="pro-idea-body"><small>기획 ${i + 1}</small><h5>${escapeHTML(idea.title || "")}</h5><p><b>썸네일 문구</b> ${escapeHTML(idea.thumbnailText || "")}</p><p><b>도입 훅</b> ${escapeHTML(idea.hook || "")}</p><p class="muted">${escapeHTML(idea.rationale || "")}</p></div></article>`).join("")}</div><p class="notice">${escapeHTML(plan.limits || "노출 수와 시청 지속 시간은 제공된 공개 자료에서 확인할 수 없습니다.")} 제목·썸네일 기획은 Gemini가 생성합니다. 실제 이미지 4장 생성은 Google Gemini 이미지 API 호출이며 요금이 발생할 수 있습니다.</p></section>`;
    $("#generateThumbs")?.addEventListener("click", generateThumbnails);
    renderMetrics();
  }

  async function createProfessionalPlan() {
    if (!state.items.length) { toast("먼저 영상 검색을 해 주세요."); return; }
    state.view = "professional";
    state.proPlan = null;
    state.proError = null;
    state.thumbnailImages = [];
    state.proLoading = true;
    render();
    try {
      state.proPlan = await api("/api/professional", { query: state.query, videos: state.items.slice(0, 15) });
    } catch (error) {
      state.proError = error;
    } finally {
      state.proLoading = false;
      render();
    }
  }

  async function generateThumbnails() {
    if (!state.proPlan?.titleThumbnailIdeas?.length || state.thumbnailLoading) return;
    if (!window.confirm("썸네일 이미지 4장을 Gemini 이미지 API로 생성합니다. 공식 표시 기준 약 $0.07이며, 실제 청구액은 이미지 크기와 Google 요금에 따라 달라질 수 있습니다. 계속할까요?")) return;
    state.thumbnailLoading = true;
    render();
    try {
      const concepts = state.proPlan.titleThumbnailIdeas.slice(0, 4);
      state.thumbnailImages = await Promise.all(concepts.map((idea) => api("/api/thumbnail", { title: idea.title, visualBrief: `${idea.thumbnailText || ""}. ${idea.visualBrief || ""}` })));
    } catch (error) {
      toast(error.code === "gemini_image_billing_required" ? "이미지 생성에는 Gemini 유료 API 설정이 필요합니다." : error.message);
    } finally {
      state.thumbnailLoading = false;
      render();
    }
  }

  function openVideo(item) {
    if (!item) return;
    $("#modalTitle").textContent = item.title;
    $("#modalBody").innerHTML = `<div class="channel-line">${escapeHTML(item.channelTitle)} · ${date(item.publishedAt)}</div><div class="modal-metrics"><div class="metric"><div class="metric-label">조회수</div><div class="metric-value">${compact(item.views)}</div></div><div class="metric"><div class="metric-label">좋아요</div><div class="metric-value">${compact(item.likes)}</div></div><div class="metric"><div class="metric-label">일 조회수 추정</div><div class="metric-value">${compact(item.viewsPerDay)}</div></div></div><p>${escapeHTML(item.description.slice(0, 900))}</p><p>일 조회수는 누적 조회수를 게시 후 경과 일수로 나눈 단순 평균입니다.</p><button class="primary" id="saveVideo" style="height:36px">${state.saved.has(item.id) ? "저장 취소" : "영상 저장"}</button>`;
    const series = state.snapshots[item.id] || item.observedSeries || [];
    const max = Math.max(1, ...series.map(point => point.views));
    const historyBars = series.map(point => `<i style="height:${Math.max(5, Math.round(point.views / max * 100))}%" title="${date(point.at)} · ${compact(point.views)} 조회"></i>`).join("");
    $("#modalBody").insertAdjacentHTML("beforeend", `<section class="video-history"><h4>관측 조회수 추이</h4><p>${series.length > 1 ? `${series.length}회 관측 · 하루에 한 번 이상 다시 검색하면 변화가 쌓입니다.` : "두 번 이상 검색하면 이 브라우저에서 관측한 변화를 표시합니다."}</p><div class="tracked-chart">${historyBars || "<span>아직 누적된 관측 기록이 없습니다.</span>"}</div></section>`);
    $("#modal").classList.add("show");
    $("#saveVideo").addEventListener("click", () => {
      if (state.saved.has(item.id)) { state.saved.delete(item.id); delete state.savedData[item.id]; }
      else { state.saved.add(item.id); state.savedData[item.id] = { ...item, folder: state.folders[0] || "기본" }; }
      localStorage.setItem("viewtrap.saved", JSON.stringify([...state.saved]));
      localStorage.setItem("viewtrap.savedData", JSON.stringify(state.savedData));
      $("#saveVideo").textContent = state.saved.has(item.id) ? "저장 취소" : "영상 저장";
      toast(state.saved.has(item.id) ? "저장한 영상에 추가했어요" : "저장을 취소했어요");
      renderMetrics();
    });
  }

  function render() {
    const pages = {
      videos: ["영상 찾기", "검색어로 YouTube 영상을 찾고 공개 지표를 비교해 보세요.", "영상 아이디어를 찾아보세요", "최신 공개 영상과 조회수·좋아요 정보를 검색합니다."],
      channels: ["채널 찾기", "관심 주제의 YouTube 채널과 공개 통계를 찾아보세요.", "참고할 채널을 찾아보세요", "채널 규모와 공개 영상 성과를 확인합니다."],
      analysis: ["채널 분석", "공개 채널 지표를 Gemini가 정리해 콘텐츠 아이디어를 제안합니다.", "채널의 주제와 영상을 분석하세요", "YouTube 공개 데이터를 바탕으로 Gemini 분석을 생성합니다."],
      saved: ["저장한 영상", "다시 볼 YouTube 영상 아이디어를 모아보세요.", "저장한 영상", "이 브라우저의 저장 목록을 확인합니다."],
      tracked: ["추적 채널", "등록한 채널의 공개 지표와 직접 관측한 변화를 확인하세요.", "내 채널을 추적하세요", "원하는 때에 공개 통계를 새로고침하고 변화 기록을 쌓습니다."],
      professional: ["Professional 콘텐츠 팩", "채널 심층 분석과 제목·썸네일 기획 4세트를 생성합니다.", "다음 콘텐츠를 구체화하세요", "공개 지표 기반 AI 전략 보고서와 크리에이티브 기획을 만듭니다."]
    };
    const copy = pages[state.view] || pages.videos;
    $("#pageTitle").textContent = copy[0];
    $("#crumb").textContent = copy[0];
    $("#pageSub").textContent = copy[1];
    $("#bannerTitle").textContent = copy[2];
    $("#bannerText").textContent = copy[3];
    $$("#nav button[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
    $$("#tabs button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
    $("#tabs").style.display = ["saved", "tracked", "professional"].includes(state.view) ? "none" : "flex";
    $(".search-panel").style.display = ["saved", "tracked", "professional"].includes(state.view) ? "none" : "block";
    $("#periodSelect").hidden = ["saved", "tracked", "professional"].includes(state.view);
    $$(".video-filter").forEach(node => node.style.display = state.view === "videos" ? "" : "none");
    $$(".channel-filter").forEach(node => node.style.display = state.view === "channels" ? "" : "none");
    $("#professionalBtn").style.display = state.view === "videos" ? "" : "none";
    $("#resetExcluded").hidden = state.view === "videos" ? state.hiddenVideos.size === 0 : state.view === "channels" ? state.hiddenChannels.size === 0 : true;
    $("#folderCard").hidden = state.view !== "saved";
    if (state.view === "videos") renderVideos();
    else if (state.view === "channels") renderChannels();
    else if (state.view === "analysis") renderAnalysis();
    else if (state.view === "professional") renderProfessional();
    else if (state.view === "tracked") renderTrackedChannels();
    else renderSaved();
    renderKeywords();
  }

  function publishedAfter() {
    const days = Number($("#periodSelect").value || 30);
    return new Date(Date.now() - days * 86400000).toISOString();
  }

  async function doSearch() {
    const query = $("#query").value.trim();
    if (!query) { toast("검색어를 입력해 주세요"); $("#query").focus(); return; }
    const type = state.view === "channels" || state.view === "analysis" ? "channels" : "videos";
    // Searching from the analysis tab must first show channel matches; otherwise
    // the old flow searched videos and left the channel analysis panel empty.
    if (state.view === "analysis") state.view = "channels";
    state.query = query;
    nextPageToken = null;
    loadingMore = false;
    state.channel = null;
    state.analysis = null;
    state.loading = true;
    state.error = "";
    state.keywords = [];
    render();
    lastSearchType = type;
    try {
      const result = await api("/api/search", { type, query, limit: 50, regionCode: $("#regionSelect").value, publishedAfter: type === "videos" ? publishedAfter() : undefined });
      nextPageToken = result.nextPageToken || null;
      if (type === "videos") { state.items = result.items || []; recordSnapshots(state.items); }
      else { state.channels = result.items || []; recordChannelSnapshots(state.channels); }
      state.loading = false;
      render();
      if (state.status.gemini) {
        try {
          const titles = type === "videos" ? state.items.map((item) => item.title) : state.channels.map((item) => item.title);
          const suggestions = await api("/api/keywords", { query, titles });
          state.keywords = suggestions.keywords || [];
          renderKeywords();
        } catch (error) { state.keywords = []; renderKeywords(); if (error.code === "gemini_key_invalid") toast(error.message); }
      }
    } catch (error) {
      state.loading = false;
      state.items = [];
      state.channels = [];
      $("#results").innerHTML = errorCard(error);
      $("#resultTitle").innerHTML = `${type === "videos" ? "YouTube 영상" : "YouTube 채널"} <span>연결 상태</span>`;
      renderMetrics();
      renderKeywords();
    }
  }

  async function loadAnalysis(channelId) {
    const channel = state.channels.find((item) => item.id === channelId) || state.trackedChannels[channelId] || state.analysisChannels[channelId];
    if (!channel) return;
    state.analysisChannels[channelId] = { ...channel, addedAt: state.analysisChannels[channelId]?.addedAt || Date.now() };
    localStorage.setItem("viewtrap.analysisChannels", JSON.stringify(state.analysisChannels));
    state.view = "analysis";
    state.query = channel.title;
    $("#query").value = channel.title;
    state.channel = channel;
    state.analysis = null;
    state.channelVideos = [];
    state.channelVideoToken = null;
    state.channelVideoTotal = 0;
    state.loading = true;
    state.error = "";
    render();
    try {
      const collection = await api("/api/channel-videos", { channelId });
      state.channel = collection.channel || channel;
      state.channelVideos = collection.videos || [];
      state.channelVideoToken = collection.nextPageToken || null;
      state.channelVideoTotal = collection.totalResults || channel.videos || state.channelVideos.length;
      recordSnapshots(state.channelVideos);
      state.analysis = await api("/api/analyze", { channelId, videos: state.channelVideos.slice(0, 100) });
    } catch (error) {
      state.error = error.message;
    }
    state.loading = false;
    render();
  }

  let landingView = "videos";
  const landingContent = {
    videos: { eye: "VIDEO DISCOVERY", title: "검색에서 다음 콘텐츠 아이디어를 찾아보세요", desc: "검색어와 관련된 영상의 흐름을 확인하고, 지금 주목받는 주제와 키워드를 살펴보세요.", list: ["검색을 통해 영상 트렌드를 탐색", "공개 조회수와 좋아요로 영상 비교", "Gemini 추천 키워드로 아이디어 확장"], preview: "영상 찾기", search: "⌕  브이로그, 홈카페, 여행..." },
    channels: { eye: "CHANNEL DISCOVERY", title: "관심 주제의 채널과 크리에이터를 찾아보세요", desc: "채널의 실제 공개 통계와 콘텐츠를 살펴보고, 참고할 만한 크리에이터를 발견해 보세요.", list: ["YouTube 채널 검색", "구독자·조회수·업로드 수 비교", "선택한 채널을 Gemini로 분석"], preview: "채널 찾기", search: "⌕  채널명 또는 주제를 입력하세요" },
    analysis: { eye: "CHANNEL ANALYTICS", title: "공개 지표를 Gemini 분석으로 연결하세요", desc: "최근 업로드와 현재 공개 통계를 바탕으로 채널의 주제와 콘텐츠 아이디어를 정리합니다.", list: ["채널 공개 통계와 최근 영상 수집", "Gemini가 반복 주제와 제목 패턴 요약", "실제 제공 데이터의 한계도 함께 표시"], preview: "채널 분석", search: "최근 공개 지표와 영상 분석" }
  };

  function setLandingView(view) {
    landingView = view;
    const data = landingContent[view];
    $$(".landing-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.openView === view));
    $("#featureEyebrow").textContent = data.eye;
    $("#featureTitle").textContent = data.title;
    $("#featureDesc").textContent = data.desc;
    $("#featureList").innerHTML = data.list.map((item) => `<li>${item}</li>`).join("");
    $("#previewTitle").textContent = data.preview;
    $("#previewSearch").textContent = data.search;
  }

  async function openDashboard(view = landingView) {
    state.view = ["videos", "channels", "analysis"].includes(view) ? view : "videos";
    $("#query").value = "";
    $("#landing").hidden = true;
    $(".app").style.display = "block";
    window.scrollTo(0, 0);
    await refreshStatus();
    render();
  }

  $("#searchBtn").addEventListener("click", doSearch);
  $("#query").addEventListener("keydown", (event) => { if (event.key === "Enter") doSearch(); });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button || !["videos", "channels", "analysis", "saved", "tracked", "professional"].includes(button.dataset.view)) return;
    state.view = button.dataset.view;
    closeMobileNav();
    render();
  });
  $$('[data-open-view]').forEach((button) => button.addEventListener("click", () => openDashboard(button.dataset.openView)));
  $$(".chip").forEach((button) => button.addEventListener("click", () => { $("#query").value = button.dataset.query; doSearch(); }));
  $("#filterViews").addEventListener("change", renderVideos);
  $("#sortBy").addEventListener("change", renderVideos);
  $("#filterSubs")?.addEventListener("change", renderVideos);
  $("#filterLikes")?.addEventListener("change", renderVideos);
  $("#filterContribution")?.addEventListener("change", renderVideos);
  $("#filterChannelSubs")?.addEventListener("change", renderChannels);
  $("#filterChannelViews")?.addEventListener("change", renderChannels);
  $("#filterChannelVideos")?.addEventListener("change", renderChannels);
  $("#sortChannels")?.addEventListener("change", renderChannels);
  $("#regionSelect")?.addEventListener("change", () => { if (state.query && ["videos", "channels"].includes(state.view)) doSearch(); });
  $("#professionalBtn")?.addEventListener("click", createProfessionalPlan);
  $("#resetExcluded")?.addEventListener("click", () => {
    state.hiddenVideos.clear();
    state.hiddenChannels.clear();
    localStorage.removeItem("viewtrap.hiddenVideos");
    localStorage.removeItem("viewtrap.hiddenChannels");
    render();
  });
  $("#periodSelect").addEventListener("change", () => { if (state.query && state.view === "videos") doSearch(); });
  $("#bannerAction").addEventListener("click", openGuide);
  $("#closeModal").addEventListener("click", () => $("#modal").classList.remove("show"));
  $("#modal").addEventListener("click", (event) => { if (event.target === $("#modal")) $("#modal").classList.remove("show"); });
  $("#mobileMenu").addEventListener("click", toggleMobileNav);
  $("#mobileNavBackdrop").addEventListener("click", closeMobileNav);
  $(".brand").addEventListener("click", () => { $(".app").style.display = "none"; $("#landing").hidden = false; window.scrollTo(0, 0); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") $("#modal").classList.remove("show"); });

  function openGuide() {
    $("#modalTitle").textContent = "사용법 안내";
    $("#modalBody").innerHTML = `<h4>1. 영상 찾기</h4><p>키워드를 입력하고 <b>검색하기</b>를 누르면 최근 공개 영상과 조회수·좋아요를 확인할 수 있어요. 기간, 조회수, 좋아요 필터와 정렬을 이용해 결과를 좁혀 보세요. 영상 카드를 누르면 상세 정보가 열립니다.</p><h4>2. 채널 찾기</h4><p><b>채널 찾기</b>로 이동해 채널 이름이나 주제를 검색하세요. 결과에서 구독자 수, 누적 조회수, 업로드 수 등 공개 지표를 비교할 수 있어요.</p><h4>3. 채널 분석</h4><p><b>채널 분석</b>에서 채널을 검색한 뒤 원하는 결과의 <b>Gemini 분석</b>을 누르세요. 공개 채널 정보와 최근 영상 내용을 바탕으로 반복 주제와 콘텐츠 아이디어를 요약합니다.</p><div class="notice">실시간 검색은 YouTube 공개 API를 사용하며, Gemini 분석은 설정된 Gemini API를 호출합니다. 제공되지 않는 비공개 지표는 볼 수 없고 API 할당량이나 연결 상태에 따라 결과가 제한될 수 있어요.</div>`;
    $("#modal").classList.add("show");
  }

  function toggleMobileNav() {
    const open = !$(".app").classList.contains("mobile-nav-open");
    $(".app").classList.toggle("mobile-nav-open", open);
    $("#sidebar").classList.toggle("mobile-open", open);
    $("#mobileMenu").setAttribute("aria-expanded", String(open));
  }

  function closeMobileNav() {
    $(".app").classList.remove("mobile-nav-open");
    $("#sidebar").classList.remove("mobile-open");
    $("#mobileMenu").setAttribute("aria-expanded", "false");
  }

  setLandingView("videos");
  render();
})();
