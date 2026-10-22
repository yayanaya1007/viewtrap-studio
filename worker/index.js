const page = __PAGE_HTML__;
const client = __CLIENT_JS__;

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeError(error) {
  if (error?.code === "youtube_key_missing" || error?.code === "gemini_key_missing") return error;
  return { code: error?.code || "upstream_error", message: error?.message || "요청을 처리하지 못했습니다." };
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 20000) throw Object.assign(new Error("요청 내용이 너무 깁니다."), { code: "request_too_large" });
  try { return JSON.parse(text || "{}"); }
  catch { throw Object.assign(new Error("올바른 JSON 요청이 아닙니다."), { code: "invalid_json" }); }
}

async function googleJson(path, params, apiKey) {
  const url = new URL(`${YOUTUBE_API}/${path}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = result?.error?.errors?.[0]?.reason || result?.error?.status;
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      throw Object.assign(new Error("YouTube 검색 할당량을 다 사용했습니다. 할당량은 매일 초기화됩니다."), { code: "youtube_quota_exceeded" });
    }
    if (reason === "keyInvalid" || reason === "API_KEY_INVALID") {
      throw Object.assign(new Error("YouTube API 키를 확인해 주세요."), { code: "youtube_key_invalid" });
    }
    throw Object.assign(new Error("YouTube에서 데이터를 가져오지 못했습니다. API 설정과 검색어를 확인해 주세요."), { code: "youtube_request_failed" });
  }
  return result;
}

function durationLabel(value = "PT0S") {
  const m = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const h = Number(m?.[1] || 0), min = Number(m?.[2] || 0), sec = Number(m?.[3] || 0);
  return h ? `${h}:${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${min}:${String(sec).padStart(2,"0")}`;
}

function elapsedDays(date) {
  return Math.max(1, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
}

function normalizeVideo(video, channel = {}) {
  const views = Number(video.statistics?.viewCount || 0);
  const likes = Number(video.statistics?.likeCount || 0);
  const publishedAt = video.snippet?.publishedAt || "";
  return {
    id: video.id,
    title: video.snippet?.title || "제목 없음",
    description: video.snippet?.description || "",
    channelTitle: video.snippet?.channelTitle || channel.snippet?.title || "채널",
    channelId: video.snippet?.channelId || channel.id || "",
    channelDescription: channel.snippet?.description || "",
    channelUrl: channel.id ? `https://www.youtube.com/channel/${channel.id}` : "",
    subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount || 0),
    views,
    likes,
    likeRate: views ? Number((likes / views * 100).toFixed(2)) : 0,
    viewsPerDay: Math.round(views / elapsedDays(publishedAt)),
    publishedAt,
    duration: durationLabel(video.contentDetails?.duration),
    thumbnail: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || "",
    url: `https://www.youtube.com/watch?v=${video.id}`,
  };
}

function normalizeChannel(channel) {
  const s = channel.statistics || {};
  return {
    id: channel.id,
    title: channel.snippet?.title || "채널",
    description: channel.snippet?.description || "",
    thumbnail: channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url || "",
    subscribers: s.hiddenSubscriberCount ? null : Number(s.subscriberCount || 0),
    views: Number(s.viewCount || 0),
    videos: Number(s.videoCount || 0),
    uploadsPlaylist: channel.contentDetails?.relatedPlaylists?.uploads || "",
    url: `https://www.youtube.com/channel/${channel.id}`,
  };
}

async function searchVideos(query, body, env) {
  const limit = Math.min(50, Math.max(1, Number(body.limit) || 20));
  const search = await googleJson("search", {
    part: "snippet", type: "video", q: query, maxResults: limit,
    order: body.order === "date" ? "date" : "relevance",
    regionCode: /^[A-Z]{2}$/.test(body.regionCode || "") ? body.regionCode : "KR",
    relevanceLanguage: ({ KR: "ko", JP: "ja", US: "en", GB: "en", CA: "en", AU: "en" })[body.regionCode] || "ko",
    publishedAfter: body.publishedAfter,
    pageToken: /^[\w-]{1,256}$/.test(body.pageToken || "") ? body.pageToken : undefined,
  }, env.YOUTUBE_API_KEY);
  const ids = (search.items || []).map(x => x.id?.videoId).filter(Boolean);
  if (!ids.length) return { type: "videos", query, items: [], nextPageToken: search.nextPageToken || null };
  const [details, channelData] = await Promise.all([
    googleJson("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, env.YOUTUBE_API_KEY),
    googleJson("channels", { part: "snippet,statistics", id: [...new Set((search.items || []).map(x => x.snippet?.channelId).filter(Boolean))].join(",") }, env.YOUTUBE_API_KEY),
  ]);
  const channels = new Map((channelData.items || []).map(x => [x.id, x]));
  return { type: "videos", query, items: (details.items || []).map(item => normalizeVideo(item, channels.get(item.snippet?.channelId))), nextPageToken: search.nextPageToken || null };
}

async function searchChannels(query, body, env) {
  const limit = Math.min(50, Math.max(1, Number(body.limit) || 20));
  const regionCode = /^[A-Z]{2}$/.test(body.regionCode || "") ? body.regionCode : "KR";
  const search = await googleJson("search", { part: "snippet", type: "channel", q: query, maxResults: limit, regionCode, relevanceLanguage: ({ KR: "ko", JP: "ja", US: "en", GB: "en", CA: "en", AU: "en" })[regionCode] || "ko", pageToken: /^[\w-]{1,256}$/.test(body.pageToken || "") ? body.pageToken : undefined }, env.YOUTUBE_API_KEY);
  const ids = (search.items || []).map(x => x.id?.channelId).filter(Boolean);
  if (!ids.length) return { type: "channels", query, items: [], nextPageToken: search.nextPageToken || null };
  const details = await googleJson("channels", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, env.YOUTUBE_API_KEY);
  return { type: "channels", query, items: (details.items || []).map(normalizeChannel), nextPageToken: search.nextPageToken || null };
}

function channelReference(input) {
  const value = String(input || "").trim();
  const idMatch = value.match(/(?:youtube\.com\/(?:channel\/)?|^)(UC[\w-]{20,})/i);
  if (idMatch) return { channelId: idMatch[1] };
  const handleMatch = value.match(/(?:youtube\.com\/(?:@|channel\/))?(@[\w.-]{2,})/i);
  if (handleMatch) return { handle: handleMatch[1].replace(/^@/, "") };
  const userMatch = value.match(/youtube\.com\/user\/([\w.-]+)/i);
  if (userMatch) return { username: userMatch[1] };
  return null;
}

async function resolveChannel(body, env) {
  const ref = channelReference(body.input);
  if (ref) {
    const query = ref.channelId ? { id: ref.channelId } : ref.handle ? { forHandle: ref.handle } : { forUsername: ref.username };
    const result = await googleJson("channels", { part: "snippet,statistics,contentDetails", ...query }, env.YOUTUBE_API_KEY);
    const channel = result.items?.[0];
    if (!channel) throw Object.assign(new Error("해당 YouTube 채널을 찾지 못했습니다."), { code: "channel_not_found" });
    return { item: normalizeChannel(channel) };
  }
  const result = await searchChannels(String(body.input || "").trim().slice(0, 120), { limit: 10, regionCode: body.regionCode }, env);
  return { items: result.items };
}

async function channelDetails(body, env) {
  const channelId = String(body.channelId || "").trim();
  if (!/^UC[\w-]{20,}$/.test(channelId)) throw Object.assign(new Error("유효한 YouTube 채널을 선택해 주세요."), { code: "invalid_channel" });
  const channels = await googleJson("channels", { part: "snippet,statistics,contentDetails", id: channelId }, env.YOUTUBE_API_KEY);
  const raw = channels.items?.[0];
  if (!raw) throw Object.assign(new Error("채널을 찾지 못했습니다."), { code: "channel_not_found" });
  const channel = normalizeChannel(raw);
  const uploads = channel.uploadsPlaylist ? await googleJson("playlistItems", { part: "snippet,contentDetails", playlistId: channel.uploadsPlaylist, maxResults: 10 }, env.YOUTUBE_API_KEY) : { items: [] };
  const ids = (uploads.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
  const videos = ids.length ? await googleJson("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, env.YOUTUBE_API_KEY) : { items: [] };
  return { channel, videos: (videos.items || []).map(item => normalizeVideo(item, raw)) };
}

async function channelVideos(body, env) {
  const channelId = String(body.channelId || "").trim();
  if (!/^UC[\w-]{20,}$/.test(channelId)) throw Object.assign(new Error("유효한 YouTube 채널을 선택해 주세요."), { code: "invalid_channel" });
  const channels = await googleJson("channels", { part: "snippet,statistics,contentDetails", id: channelId }, env.YOUTUBE_API_KEY);
  const raw = channels.items?.[0];
  if (!raw) throw Object.assign(new Error("채널을 찾지 못했습니다."), { code: "channel_not_found" });
  const channel = normalizeChannel(raw);
  if (!channel.uploadsPlaylist) return { channel, videos: [], nextPageToken: null, totalResults: 0 };
  const token = /^[\w-]{1,256}$/.test(body.pageToken || "") ? body.pageToken : undefined;
  const page = await googleJson("playlistItems", { part: "snippet,contentDetails", playlistId: channel.uploadsPlaylist, maxResults: 50, pageToken: token }, env.YOUTUBE_API_KEY);
  const ids = (page.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
  const data = ids.length ? await googleJson("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, env.YOUTUBE_API_KEY) : { items: [] };
  return { channel, videos: (data.items || []).map(item => normalizeVideo(item, raw)), nextPageToken: page.nextPageToken || null, totalResults: page.pageInfo?.totalResults || channel.videos };
}

async function refreshTrackedChannels(body, env) {
  const ids = [...new Set((Array.isArray(body.channelIds) ? body.channelIds : []).map(id => String(id).trim()).filter(id => /^UC[\w-]{20,}$/.test(id)))].slice(0, 50);
  if (!ids.length) return { items: [] };
  const details = await googleJson("channels", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, env.YOUTUBE_API_KEY);
  return { items: (details.items || []).map(normalizeChannel) };
}

async function refreshSavedVideos(body, env) {
  const ids = [...new Set((Array.isArray(body.videoIds) ? body.videoIds : []).map(id => String(id).trim()).filter(id => /^[\w-]{11}$/.test(id)))].slice(0, 50);
  if (!ids.length) return { items: [] };
  const videosResult = await googleJson("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, env.YOUTUBE_API_KEY);
  const channelIds = [...new Set((videosResult.items || []).map(video => video.snippet?.channelId).filter(Boolean))];
  const channelsResult = channelIds.length ? await googleJson("channels", { part: "statistics", id: channelIds.join(",") }, env.YOUTUBE_API_KEY) : { items: [] };
  const channels = new Map((channelsResult.items || []).map(channel => [channel.id, channel]));
  return { items: (videosResult.items || []).map(video => normalizeVideo(video, channels.get(video.snippet?.channelId))) };
}
async function geminiText(prompt, env) {
  if (!env.GEMINI_API_KEY) throw Object.assign(new Error("Gemini API 키가 아직 등록되지 않았습니다."), { code: "gemini_key_missing" });
  const model = /^[a-zA-Z0-9.-]+$/.test(env.GEMINI_MODEL || "") ? env.GEMINI_MODEL : "gemini-3.8-flash";
  const url = `${GEMINI_API}/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.35, maxOutputTokens: 1200 } }),
    signal: AbortSignal.timeout(25000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = result?.error?.details?.find(item => item?.["@type"]?.includes("ErrorInfo"))?.reason || result?.error?.status || "unknown";
    const providerMessage = String(result?.error?.message || "").toLowerCase();
    const invalidKey = reason === "API_KEY_INVALID" || providerMessage.includes("api key not valid");
    const code = response.status === 429 ? "gemini_quota_exceeded" : invalidKey ? "gemini_key_invalid" : response.status === 403 ? "gemini_permission_denied" : response.status === 402 || providerMessage.includes("billing") || providerMessage.includes("paid plan") ? "gemini_billing_required" : response.status === 404 ? "gemini_model_not_found" : response.status === 400 ? "gemini_bad_request" : "gemini_request_failed";
    const message = code === "gemini_quota_exceeded" ? "Gemini 사용량 한도에 도달했습니다." : code === "gemini_key_invalid" ? "Gemini API 키가 거부되었습니다. Google AI Studio에서 키 상태와 제한 설정을 확인해 주세요." : code === "gemini_permission_denied" ? "Gemini API 키에 필요한 권한이 없습니다. 키가 Generative Language API를 사용할 수 있는지 확인해 주세요." : code === "gemini_billing_required" ? "현재 Google 프로젝트에서 Gemini API를 사용하려면 결제 설정이 필요합니다." : code === "gemini_model_not_found" ? "Gemini 모델 " + model + "을 찾을 수 없거나 사용할 권한이 없습니다." : code === "gemini_bad_request" ? "Gemini 요청 형식이 거부되었습니다. 서버 로그의 상태 코드를 확인해 주세요." : "Gemini 서비스가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    console.error("Gemini GenerateContent failed", { httpStatus: response.status, reason, model });
    throw Object.assign(new Error(message), { code, reason });
  }
  return (result.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
}

async function analyzeChannel(body, env) {
  if (!env.YOUTUBE_API_KEY) throw Object.assign(new Error("YouTube API 키가 아직 등록되지 않았습니다."), { code: "youtube_key_missing" });
  const channelId = String(body.channelId || "").trim();
  if (!/^UC[\w-]{20,}$/.test(channelId)) throw Object.assign(new Error("유효한 YouTube 채널을 선택해 주세요."), { code: "invalid_channel" });
  const channelResult = await googleJson("channels", { part: "snippet,statistics,contentDetails", id: channelId }, env.YOUTUBE_API_KEY);
  const rawChannel = channelResult.items?.[0];
  if (!rawChannel) throw Object.assign(new Error("채널을 찾지 못했습니다."), { code: "channel_not_found" });
  const channel = normalizeChannel(rawChannel);
  let videos = Array.isArray(body.videos) ? body.videos.slice(0, 100).map(item => ({
    title: String(item.title || "").slice(0, 180), views: Math.max(0, Number(item.views) || 0), likes: Math.max(0, Number(item.likes) || 0),
    viewsPerDay: Math.max(0, Number(item.viewsPerDay) || 0), likeRate: Math.max(0, Number(item.likeRate) || 0), publishedAt: String(item.publishedAt || "").slice(0, 40),
  })) : [];
  if (!videos.length) {
    const uploads = channel.uploadsPlaylist ? await googleJson("playlistItems", { part: "snippet,contentDetails", playlistId: channel.uploadsPlaylist, maxResults: 10 }, env.YOUTUBE_API_KEY) : { items: [] };
    const ids = (uploads.items || []).map(x => x.contentDetails?.videoId).filter(Boolean);
    const videosResult = ids.length ? await googleJson("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, env.YOUTUBE_API_KEY) : { items: [] };
    videos = (videosResult.items || []).map(x => normalizeVideo(x, rawChannel));
  }
  const data = { channel: { title: channel.title, subscribers: channel.subscribers, views: channel.views, videos: channel.videos }, recentVideos: videos.map(v => ({ title: v.title, views: v.views, viewsPerDay: v.viewsPerDay, likeRate: v.likeRate, publishedAt: v.publishedAt })) };
  const prompt = `너는 한국어 YouTube 콘텐츠 전략 분석가다. 아래 YouTube Data API 공개 지표만 사용해 간결하게 분석하라. 실제로 알 수 없는 노출 수, 시청 지속 시간, 알고리즘 추천 여부는 추측하지 말고 공개 데이터의 한계를 밝혀라.\n\n데이터:\n${JSON.stringify(data)}\n\n다음 순서로 한국어 Markdown을 작성하라: 1) 채널 현황 요약 2) 최근 영상에서 반복되는 주제와 제목 패턴 3) 현재 상위 반응 영상에서 관찰되는 점 4) 다음 영상 아이디어 3개 5) 지표 해석의 한계. 근거 없는 수치나 사실을 만들지 말고, 제공된 영상 제목과 공개 수치만 근거로 삼아라.`;
  const analysis = await geminiText(prompt, env);
  return { channel, recentVideos: videos, analysis };
}

async function suggestKeywords(body, env) {
  const query = String(body.query || "").trim().slice(0, 120);
  if (!query) throw Object.assign(new Error("검색어를 입력해 주세요."), { code: "query_required" });
  const titles = Array.isArray(body.titles) ? body.titles.slice(0, 10).map(x => String(x).slice(0, 160)) : [];
  const prompt = `한국어 YouTube 콘텐츠 기획자를 위해 검색어 확장 키워드 8개를 제안하라. 각 항목은 짧은 검색어여야 하며 검색량이나 인기도 수치는 만들지 마라. 원본 검색어: ${query}\n관련 영상 제목: ${JSON.stringify(titles)}\nJSON만 반환: {"keywords":["키워드1",...]}`;
  const text = await geminiText(prompt, env);
  const match = text.match(/\{[\s\S]*\}/);
  let keywords = [];
  try { keywords = JSON.parse(match?.[0] || "{}").keywords || []; } catch {}
  return { keywords: keywords.filter(x => typeof x === "string").slice(0, 8) };
}

async function professionalPlan(body, env) {
  const query = String(body.query || "").trim().slice(0, 120);
  if (!query) throw Object.assign(new Error("검색어나 채널을 입력해 주세요."), { code: "query_required" });
  const videos = Array.isArray(body.videos) ? body.videos.slice(0, 15).map((v) => ({
    title: String(v.title || "").slice(0, 180),
    views: Math.max(0, Number(v.views) || 0),
    likes: Math.max(0, Number(v.likes) || 0),
    subscribers: v.subscriberCount == null ? null : Math.max(0, Number(v.subscriberCount) || 0),
    viewsPerDay: Math.max(0, Number(v.viewsPerDay) || 0),
    publishedAt: String(v.publishedAt || "").slice(0, 40),
    channelTitle: String(v.channelTitle || "").slice(0, 100),
  })) : [];
  if (!videos.length) throw Object.assign(new Error("먼저 영상 검색을 실행해 주세요."), { code: "videos_required" });
  const prompt = `너는 한국어 YouTube 콘텐츠 전략 컨설턴트다. 입력된 공개 지표와 영상 제목만 근거로, Professional 콘텐츠 전략 보고서를 JSON으로 만들어라. 조회수 수치, 검색량, 노출 수, 시청 지속 시간, 알고리즘 추천 여부를 만들어내지 마라. 제공된 자료에서 확인할 수 없는 것은 가설이라고 표시하라. titleThumbnailIdeas는 정확히 4개여야 하고, 각 항목에는 title(제목), thumbnailText(짧은 썸네일 문구), visualBrief(화면 구도와 시각 콘셉트), hook(영상 첫 10초 도입), rationale(공개 자료와 연결된 이유)가 있어야 한다. 텍스트는 서로 다른 방향으로 제안하라.
주제/채널: ${query}
공개 자료: ${JSON.stringify(videos)}
반환 형식: {"executiveSummary":"...","audienceHypotheses":["..."],"patterns":["..."],"experiments":["...","...","..."],"titleThumbnailIdeas":[{"title":"...","thumbnailText":"...","visualBrief":"...","hook":"...","rationale":"..."}],"limits":"..."}`;
  const model = /^[a-zA-Z0-9.-]+$/.test(env.GEMINI_MODEL || "") ? env.GEMINI_MODEL : "gemini-3.8-flash";
  const url = `${GEMINI_API}/models/${model}:generateContent`;
  if (!env.GEMINI_API_KEY) throw Object.assign(new Error("Gemini API 키가 아직 등록되지 않았습니다."), { code: "gemini_key_missing" });
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.45, maxOutputTokens: 2400, responseMimeType: "application/json" } }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = result?.error?.details?.find(item => item?.["@type"]?.includes("ErrorInfo"))?.reason || result?.error?.status || "unknown";
    console.error("Gemini Professional request failed", { httpStatus: response.status, reason, model });
    const code = response.status === 429 ? "gemini_quota_exceeded" : reason === "API_KEY_INVALID" ? "gemini_key_invalid" : response.status === 403 ? "gemini_permission_denied" : response.status === 402 ? "gemini_billing_required" : response.status === 404 ? "gemini_model_not_found" : "gemini_request_failed";
    const message = code === "gemini_quota_exceeded" ? "Gemini 사용량 한도에 도달했습니다." : code === "gemini_key_invalid" ? "Gemini API 키가 거부되었습니다. Google AI Studio에서 키 상태와 제한 설정을 확인해 주세요." : code === "gemini_permission_denied" ? "Gemini API 키에 필요한 권한이 없습니다. 키의 Gemini API 접근과 프로젝트 설정을 확인해 주세요." : code === "gemini_billing_required" ? "Google 프로젝트의 결제 설정이 필요합니다." : code === "gemini_model_not_found" ? "Gemini 모델 " + model + "을 찾을 수 없거나 사용할 권한이 없습니다." : "Professional 분석 요청을 처리하지 못했습니다.";
    throw Object.assign(new Error(message), { code, reason });
  }
  const text = (result.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return { ...parsed, titleThumbnailIdeas: Array.isArray(parsed.titleThumbnailIdeas) ? parsed.titleThumbnailIdeas.slice(0, 4) : [] };
  } catch {
    throw Object.assign(new Error("Gemini가 읽을 수 있는 보고서 형식으로 응답하지 않았습니다. 다시 시도해 주세요."), { code: "gemini_invalid_response" });
  }
}

async function generateThumbnail(body, env) {
  if (!env.GEMINI_API_KEY) throw Object.assign(new Error("Gemini API 키가 아직 등록되지 않았습니다."), { code: "gemini_key_missing" });
  const title = String(body.title || "").trim().slice(0, 140);
  const visualBrief = String(body.visualBrief || "").trim().slice(0, 800);
  if (!title || !visualBrief) throw Object.assign(new Error("제목과 썸네일 기획안을 선택해 주세요."), { code: "concept_required" });
  const model = /^[a-zA-Z0-9.-]+$/.test(env.GEMINI_IMAGE_MODEL || "") ? env.GEMINI_IMAGE_MODEL : "gemini-3.1-flash-lite-image";
  const prompt = `Create one original YouTube thumbnail background, 16:9 landscape, clean composition with clear focal point. Do not include readable text, logos, watermarks, or recognizable real people. Leave uncluttered negative space where a Korean title can be placed later. Concept title: ${title}. Visual direction: ${visualBrief}`;
  const response = await fetch(`${GEMINI_API}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(response.status === 429 ? "이미지 생성 사용량 한도에 도달했습니다." : response.status === 403 ? "이 Gemini 키에서 이미지 생성이 활성화되어 있지 않습니다. Google AI 요금 설정을 확인해 주세요." : "썸네일 이미지를 만들지 못했습니다."), { code: response.status === 429 ? "gemini_quota_exceeded" : response.status === 403 ? "gemini_image_billing_required" : "gemini_image_failed" });
  const image = (result.candidates?.[0]?.content?.parts || []).find(part => part.inlineData?.data);
  if (!image) throw Object.assign(new Error("이미지 응답을 받지 못했습니다. 다시 시도해 주세요."), { code: "gemini_image_missing" });
  return { mimeType: image.inlineData.mimeType || "image/png", data: image.inlineData.data };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (request.method === "GET" && url.pathname === "/client.js") return new Response(client, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    if (request.method === "GET" && url.pathname === "/api/status") return json({ youtube: Boolean(env.YOUTUBE_API_KEY), gemini: Boolean(env.GEMINI_API_KEY) });
    try {
      const body = await readBody(request);
      if (request.method === "POST" && url.pathname === "/api/search") {
        const query = String(body.query || "").trim().slice(0, 120);
        if (!query) throw Object.assign(new Error("검색어를 입력해 주세요."), { code: "query_required" });
        if (!env.YOUTUBE_API_KEY) throw Object.assign(new Error("YouTube Data API 키가 아직 등록되지 않았습니다."), { code: "youtube_key_missing" });
        return json(body.type === "channels" ? await searchChannels(query, body, env) : await searchVideos(query, body, env));
      }
      if (request.method === "POST" && url.pathname === "/api/resolve-channel") {
        if (!env.YOUTUBE_API_KEY) throw Object.assign(new Error("YouTube Data API 키가 아직 등록되지 않았습니다."), { code: "youtube_key_missing" });
        return json(await resolveChannel(body, env));
      }
      if (request.method === "POST" && url.pathname === "/api/channel-details") {
        if (!env.YOUTUBE_API_KEY) throw Object.assign(new Error("YouTube Data API 키가 아직 등록되지 않았습니다."), { code: "youtube_key_missing" });
        return json(await channelDetails(body, env));
      }
      if (request.method === "POST" && url.pathname === "/api/channel-videos") {
        if (!env.YOUTUBE_API_KEY) throw Object.assign(new Error("YouTube Data API 키가 아직 등록되지 않았습니다."), { code: "youtube_key_missing" });
        return json(await channelVideos(body, env));
      }
      if (request.method === "POST" && url.pathname === "/api/tracked-channels") {
        if (!env.YOUTUBE_API_KEY) throw Object.assign(new Error("YouTube Data API 키가 아직 등록되지 않았습니다."), { code: "youtube_key_missing" });
        return json(await refreshTrackedChannels(body, env));
      }
      if (request.method === "POST" && url.pathname === "/api/refresh-videos") {
        if (!env.YOUTUBE_API_KEY) throw Object.assign(new Error("YouTube Data API 키가 아직 등록되지 않았습니다."), { code: "youtube_key_missing" });
        return json(await refreshSavedVideos(body, env));
      }
      if (request.method === "POST" && url.pathname === "/api/analyze") return json(await analyzeChannel(body, env));
      if (request.method === "POST" && url.pathname === "/api/keywords") return json(await suggestKeywords(body, env));
      if (request.method === "POST" && url.pathname === "/api/professional") return json(await professionalPlan(body, env));
      if (request.method === "POST" && url.pathname === "/api/thumbnail") return json(await generateThumbnail(body, env));
      return json({ code: "not_found", message: "요청한 주소를 찾을 수 없습니다." }, 404);
    } catch (error) {
      const result = safeError(error);
      const status = result.code === "youtube_key_missing" || result.code === "gemini_key_missing" ? 503 : result.code === "invalid_channel" || result.code === "query_required" || result.code === "invalid_json" ? 400 : 502;
      return json(result, status);
    }
  },
};
