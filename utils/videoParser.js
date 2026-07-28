// server/utils/videoParser.js
// 多平台视频解析模块
const axios = require('axios')

// 通用请求头，模拟浏览器
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

/**
 * 主解析入口：根据URL自动识别平台
 */
async function parseVideo(url) {
  // 提取链接
  const cleanUrl = extractUrl(url)
  if (!cleanUrl) throw new Error('无法识别有效链接')

  let parsedUrl
  try {
    parsedUrl = new URL(cleanUrl)
  } catch {
    throw new Error('无法识别有效链接')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('只支持 http 或 https 链接')
  }

  const host = parsedUrl.hostname.toLowerCase()
  let result
  if (hostMatches(host, ['douyin.com', 'iesdouyin.com'])) {
    result = await parseDouyin(cleanUrl)
  } else if (hostMatches(host, ['kuaishou.com', 'gifshow.com', 'chenzhongtech.com'])) {
    result = await parseKuaishou(cleanUrl)
  } else if (hostMatches(host, ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'])) {
    result = await parseXiaohongshu(cleanUrl)
  } else if (hostMatches(host, ['weibo.com', 'weibo.cn'])) {
    result = await parseWeibo(cleanUrl)
  } else if (hostMatches(host, ['pipix.com'])) {
    result = await parsePipix(cleanUrl)
  } else if (hostMatches(host, ['bilibili.com', 'b23.tv'])) {
    result = await parseBilibili(cleanUrl)
  } else {
    // 公网服务不能抓取任意用户提供的网址，否则可能被用于访问云环境内网地址(SSRF)。
    // 只开放经过适配和域名校验的平台；新增平台时在上方显式加入解析器。
    throw new Error('暂不支持该平台，请使用抖音、快手、小红书、B站、微博或皮皮虾链接')
  }

  // 统一改走服务器代理下载（B站已在自己解析里包好，这里跳过相对路径）：
  // wx.downloadFile 只能访问白名单域名，各平台 CDN 域名无法穷举加白，
  // 且部分 CDN 校验 Referer；前端对相对路径会自动拼后端域名，
  // 只需把后端域名加入 downloadFile 合法域名即可保存到相册。
  // 统一图文结果结构：单图也按 imageUrls 数组返回，前端可复用同一套预览/保存逻辑。
  if (result && result.isImage && (!Array.isArray(result.imageUrls) || result.imageUrls.length === 0)) {
    result.imageUrls = result.videoUrl ? [result.videoUrl] : []
  }

  // 图文作品返回多张图片时，每张都走服务器代理；前端只需配置后端一个下载域名。
  if (result && Array.isArray(result.imageUrls) && result.imageUrls.length > 0) {
    result.imageUrls = result.imageUrls.map(url => /^https?:\/\//i.test(url)
      ? `/api/video/proxy?url=${encodeURIComponent(url)}`
      : url)
    result.videoUrl = result.imageUrls[0]
    result.cover = result.imageUrls[0]
  } else if (result && result.videoUrl && /^https?:\/\//i.test(result.videoUrl)) {
    result.videoUrl = `/api/video/proxy?url=${encodeURIComponent(result.videoUrl)}`
  }
  return result
}

/**
 * 从分享文本中提取URL
 */
function extractUrl(text) {
  const match = String(text || '').match(/https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/)
  return match ? match[0].replace(/[),.;!?]+$/g, '') : null
}

function hostMatches(hostname, allowedDomains) {
  return allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

function assertAllowedRedirect(url, allowedDomains, platformName) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${platformName}链接跳转地址无效`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) ||
      !hostMatches(parsed.hostname.toLowerCase(), allowedDomains)) {
    throw new Error(`${platformName}链接跳转到了非官方地址，已停止访问`)
  }
  return url
}

/**
 * 获取重定向后的真实URL
 */
async function getRedirectUrl(url) {
  try {
    const res = await axios.get(url, {
      headers: HEADERS,
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400
    })
    return res.headers.location || url
  } catch (err) {
    if (err.response && err.response.headers.location) {
      return err.response.headers.location
    }
    return url
  }
}

/**
 * 抖音解析
 * 官方 JSON API(iesdouyin.com/web/api/v2/aweme/iteminfo)已加入签名校验，
 * 直连会返回 encrypt_data_miss，因此改为请求分享页 HTML，
 * 从页面内嵌的 _ROUTER_DATA(Next.js SSR 数据) 里取作品信息。
 * 该数据同时覆盖普通视频(/share/video/)和图文作品(/share/note/)两种页面。
 */
async function parseDouyin(url) {
  // 短链接先获取重定向，落地到 iesdouyin.com/share/video|note/<id>/
  const realUrl = assertAllowedRedirect(
    await getRedirectUrl(url),
    ['douyin.com', 'iesdouyin.com'],
    '抖音'
  )

  const res = await axios.get(realUrl, { headers: HEADERS })
  const html = res.data

  const routerMatch = html.match(/_ROUTER_DATA\s*=\s*(\{.+?\})\s*<\/script>/)
  if (!routerMatch) throw new Error('无法解析抖音页面数据')

  const routerData = JSON.parse(routerMatch[1])
  const pageKey = Object.keys(routerData.loaderData || {}).find(k => k.endsWith('/page'))
  const item = pageKey && routerData.loaderData[pageKey].videoInfoRes &&
               routerData.loaderData[pageKey].videoInfoRes.item_list &&
               routerData.loaderData[pageKey].videoInfoRes.item_list[0]
  if (!item) throw new Error('视频不存在或已被删除')

  const title = item.desc || '抖音视频'

  // 图文作品(aweme_type=68/2 等)：每张图从 url_list 中优先选择 JPEG，
  // 返回完整 imageUrls，复用前端图集预览和“保存全部图片”逻辑。
  if (item.images && item.images.length > 0) {
    const imageUrls = item.images
      .map(image => pickImageUrl(image && image.url_list))
      .filter(Boolean)
    if (imageUrls.length === 0) throw new Error('无法获取抖音图文作品图片')
    return {
      videoUrl: imageUrls[0],
      imageUrls,
      cover: imageUrls[0],
      title,
      isImage: true
    }
  }

  // 普通视频：获取无水印地址(playwm→play)
  let videoUrl = item.video.play_addr.url_list[0]
  videoUrl = videoUrl.replace('playwm', 'play')

  return {
    videoUrl,
    cover: (item.video.cover && item.video.cover.url_list[0]) || '',
    title
  }
}

/**
 * 从图文 url_list 里选一个链接：优先选 jpeg 格式(小程序 image 组件对 webp 兼容性不如 jpeg)，
 * 找不到就用最后一项(通常是清晰度适中的版本)。
 */
function pickImageUrl(urlList) {
  if (!urlList || urlList.length === 0) return ''
  const jpeg = urlList.find(u => /\.jpe?g(\?|$)/i.test(u))
  return jpeg || urlList[urlList.length - 1]
}

/**
 * 快手解析。
 * 注意：页面里的 v*-vod.kwaicdn.com/....mp4 其实是 HLS remux 流(路径带 hls-ts，
 * Content-Type 是 application/vnd.apple.mpegurl)，下载下来只是个 m3u8 文本清单，
 * 会导致保存相册得到坏文件、口播提取抽音轨失败。
 * 真正的 mp4 直链在 photoUrl/mainMvUrls 字段，域名为 kwimgs.com / yximgs.com，
 * 因此优先取这些字段，并显式过滤掉含 hls/m3u8 的地址。
 */
async function parseKuaishou(url) {
  const realUrl = assertAllowedRedirect(
    await getRedirectUrl(url),
    ['kuaishou.com', 'gifshow.com', 'chenzhongtech.com'],
    '快手'
  )

  const res = await axios.get(realUrl, {
    headers: { ...HEADERS, Referer: 'https://www.kuaishou.com/' }
  })

  const html = res.data

  // 当前分享页的结构化数据统一放在 INIT_STATE 中。优先按作品对象读取，
  // 这样可以区分视频、单图和图集，避免把图集误报成“未找到 mp4”。
  const stateMatch = html.match(/window\.INIT_STATE\s*=\s*(\{.*?\})\s*<\/script>/s)
  let photoData = null
  if (stateMatch) {
    try {
      photoData = findKuaishouPhoto(JSON.parse(stateMatch[1]))
    } catch {
      photoData = null
    }
  }
  if (photoData && photoData.photo) {
    const photo = photoData.photo
    const title = photo.caption || '快手作品'
    const mainVideo = (photo.mainMvUrls || []).map(item => item && item.url).find(Boolean)
    if (mainVideo) {
      return {
        videoUrl: mainVideo,
        cover: pickKuaishouUrl(photo.coverUrls),
        title
      }
    }

    if (photo.singlePicture && photoData.atlas) {
      const imageUrls = buildKuaishouAtlasImages(photoData.atlas)
      if (imageUrls.length === 0) throw new Error('无法获取快手图文作品图片')
      return {
        videoUrl: imageUrls[0],
        imageUrls,
        cover: imageUrls[0],
        title,
        isImage: true
      }
    }
  }

  // 兼容旧分享页：真 mp4 直链不含 hls-ts/m3u8；优先 photoUrl / srcNoMark / mainMvUrls
  const isRealMp4 = (u) => u && /\.mp4/i.test(u) && !/hls|m3u8/i.test(u)
  const norm = (u) => u.replace(/\\u002F/g, '/').replace(/\\\//g, '/')

  let videoUrl = null
  const prefer = html.match(/"photoUrl"\s*:\s*"([^"]+)"/) ||
                 html.match(/"srcNoMark"\s*:\s*"([^"]+)"/) ||
                 html.match(/"mainMvUrls"\s*:\s*\[\s*\{\s*"url"\s*:\s*"([^"]+)"/)
  if (prefer && isRealMp4(norm(prefer[1]))) {
    videoUrl = norm(prefer[1])
  }

  // 保底：扫描页面所有 mp4，选第一个非 HLS 的真 mp4
  if (!videoUrl) {
    const all = [...html.matchAll(/https?:[^"'\\]*?\.mp4[^"'\\]*/g)].map(m => norm(m[0]))
    videoUrl = all.find(isRealMp4) || null
  }

  const coverMatch = html.match(/"coverUrl"\s*:\s*"([^"]+)"/) ||
                     html.match(/"poster"\s*:\s*"(https?:\/\/[^"]+)"/)
  const titleMatch = html.match(/"caption"\s*:\s*"([^"]+)"/)

  if (!videoUrl) throw new Error('无法解析快手视频(未找到无水印mp4直链)')

  return {
    videoUrl,
    cover: coverMatch ? norm(coverMatch[1]) : '',
    title: titleMatch ? titleMatch[1] : '快手视频'
  }
}

function findKuaishouPhoto(value) {
  if (!value || typeof value !== 'object') return null
  if (value.photo && typeof value.photo === 'object') return value

  const children = Array.isArray(value) ? value : Object.values(value)
  for (const child of children) {
    const found = findKuaishouPhoto(child)
    if (found) return found
  }
  return null
}

function pickKuaishouUrl(items) {
  if (!Array.isArray(items)) return ''
  const item = items.find(entry => entry && entry.url)
  return item ? item.url : ''
}

function buildKuaishouAtlasImages(atlas) {
  const paths = Array.isArray(atlas.list) ? atlas.list : []
  const cdns = Array.isArray(atlas.cdnList) ? atlas.cdnList : []
  const cdn = cdns.map(item => typeof item === 'string' ? item : item && item.cdn).find(Boolean)

  return paths
    .filter(item => typeof item === 'string' && /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(item))
    .map(path => {
      if (/^https?:\/\//i.test(path)) return path
      return cdn ? `https://${cdn}${path.startsWith('/') ? '' : '/'}${path}` : ''
    })
    .filter(Boolean)
}

/**
 * 小红书解析。
 * 页面里 sns-video 域名字符串会出现多次(推荐位/相关笔记等无关数据也含有)，
 * 用全局正则"随便抓一个"拿到的地址可能跟当前笔记完全无关；
 * 改为从页面内嵌的 window.__INITIAL_STATE__ 里按 noteData.data.noteData
 * 精确取当前这条笔记的数据，笔记类型(note.type)为 "video" 才继续，否则是图文笔记直接报错。
 */
async function parseXiaohongshu(url) {
  const realUrl = assertAllowedRedirect(
    await getRedirectUrl(url),
    ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
    '小红书'
  )

  const res = await axios.get(realUrl, {
    headers: { ...HEADERS, Referer: 'https://www.xiaohongshu.com/' }
  })

  const html = res.data

  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\})\s*<\/script>/)
  if (!stateMatch) throw new Error('无法解析小红书页面数据')

  // 小红书页面里未定义字段用 undefined 而非 null 表示，标准JSON.parse无法识别
  const stateJson = stateMatch[1].replace(/:undefined/g, ':null')
  const state = JSON.parse(stateJson)
  const note = state.noteData && state.noteData.data && state.noteData.data.noteData
  if (!note) throw new Error('笔记不存在或已被删除')

  const title = note.title || note.desc || '小红书笔记'

  if (note.type !== 'video' || !note.video) {
    throw new Error('该笔记是图文笔记，暂不支持解析')
  }

  const h264List = note.video.media && note.video.media.stream && note.video.media.stream.h264
  if (!h264List || !h264List[0]) throw new Error('无法获取小红书视频播放地址')

  // 封面用视频首帧图(imageList[0])的完整URL；fileId本身不能直接拼出可用链接(缺签名路径段)
  const coverUrl = note.imageList && note.imageList[0] && note.imageList[0].url

  return {
    videoUrl: h264List[0].masterUrl,
    cover: coverUrl || '',
    title
  }
}

/**
 * 微博解析
 */
async function parseWeibo(url) {
  const realUrl = assertAllowedRedirect(
    await getRedirectUrl(url),
    ['weibo.com', 'weibo.cn'],
    '微博'
  )

  const res = await axios.get(realUrl, {
    headers: { ...HEADERS, Referer: 'https://weibo.com/' }
  })

  const html = res.data

  // 提取视频流地址
  const videoMatch = html.match(/"stream_url_hd"\s*:\s*"([^"]+)"/) ||
                     html.match(/"stream_url"\s*:\s*"([^"]+)"/) ||
                     html.match(/"url"\s*:\s*"(https:\/\/f\.video\.weibocdn[^"]+)"/)

  if (!videoMatch) throw new Error('无法解析微博视频')

  return {
    videoUrl: videoMatch[1],
    cover: '',
    title: '微博视频'
  }
}

/**
 * 皮皮虾解析。
 * 页面里有 <script id="RENDER_DATA" type="application/json"> 标签,
 * 内容是整体URL编码的JSON,解码后从 ppxItemDetail.item.video 取视频地址。
 */
async function parsePipix(url) {
  const realUrl = assertAllowedRedirect(
    await getRedirectUrl(url),
    ['pipix.com'],
    '皮皮虾'
  )

  const res = await axios.get(realUrl, { headers: HEADERS })
  const html = res.data

  const match = html.match(/<script id="RENDER_DATA" type="application\/json">(.+?)<\/script>/)
  if (!match) throw new Error('无法解析皮皮虾页面数据')

  const decoded = decodeURIComponent(match[1])
  const data = JSON.parse(decoded)
  const item = data.ppxItemDetail && data.ppxItemDetail.item
  if (!item || !item.video) throw new Error('视频不存在或已被删除')

  const video = item.video
  const videoUrl = video.video_download && video.video_download.url_list && video.video_download.url_list[0] && video.video_download.url_list[0].url
  if (!videoUrl) throw new Error('无法获取皮皮虾视频播放地址')

  const coverUrl = video.cover_image && video.cover_image.url_list && video.cover_image.url_list[0] && video.cover_image.url_list[0].url

  return {
    videoUrl,
    cover: coverUrl || '',
    title: item.content || video.title || '皮皮虾视频'
  }
}

/**
 * B站解析。
 * 官方 view/playurl 接口需要请求头带 Referer:bilibili.com，小程序端 wx.downloadFile
 * 不允许自定义该 header，所以这里返回的地址不是CDN直链，而是走本服务代理端点，
 * 由服务器代为携带 Referer 请求 CDN 后原样转发给小程序(见 routes/video.js /proxy)。
 * 未登录状态最高只能拿到 qn=64(480P)清晰度。
 */
async function parseBilibili(url) {
  const inputHost = new URL(url).hostname.toLowerCase()
  const realUrl = hostMatches(inputHost, ['b23.tv'])
    ? assertAllowedRedirect(await getRedirectUrl(url), ['bilibili.com', 'b23.tv'], 'B站')
    : url

  const bvidMatch = realUrl.match(/BV[0-9A-Za-z]{10}/)
  if (!bvidMatch) throw new Error('无法识别B站视频BV号')
  const bvid = bvidMatch[0]

  const biliHeaders = { ...HEADERS, Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }

  const viewRes = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: biliHeaders })
  if (viewRes.data.code !== 0) throw new Error(viewRes.data.message || 'B站视频不存在或已被删除')
  const { cid, title, pic } = viewRes.data.data

  const playRes = await axios.get(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=1&platform=html5`,
    { headers: biliHeaders }
  )
  if (playRes.data.code !== 0 || !playRes.data.data.durl || !playRes.data.data.durl[0]) {
    throw new Error(playRes.data.message || '无法获取B站视频播放地址')
  }
  const cdnUrl = playRes.data.data.durl[0].url

  return {
    videoUrl: `/api/video/proxy?url=${encodeURIComponent(cdnUrl)}`,
    cover: pic || '',
    title: title || 'B站视频',
    needsProxy: true // 提示前端此地址需拼服务器域名前缀(相对路径)，与抖音等平台的绝对CDN地址不同
  }
}

/** 代理白名单：只允许转发已支持平台的官方 CDN 域名，防止被当成任意地址的匿名代理(SSRF) */
const PROXY_HOST_WHITELIST = [
  /(^|\.)bilivideo\.com$/,   // B站
  /(^|\.)douyinvod\.com$/,   // 抖音视频CDN
  /(^|\.)zjcdn\.com$/,       // 字节系CDN(抖音/皮皮虾)
  /(^|\.)bytecdn\.cn$/,
  /(^|\.)snssdk\.com$/,
  /(^|\.)iesdouyin\.com$/,
  /(^|\.)douyinpic\.com$/,   // 抖音图集
  /(^|\.)kwaicdn\.com$/,     // 快手
  /(^|\.)kwimgs\.com$/,
  /(^|\.)yximgs\.com$/,      // 快手 mp4 直链域名
  /(^|\.)gifshow\.com$/,
  /(^|\.)xhscdn\.com$/,      // 小红书
  /(^|\.)weibocdn\.com$/,    // 微博
  /(^|\.)sinaimg\.cn$/,
  /(^|\.)pipix\.com$/        // 皮皮虾
]

function isAllowedProxyTarget(urlStr) {
  try {
    const { hostname, protocol } = new URL(urlStr)
    if (protocol !== 'https:' && protocol !== 'http:') return false
    return PROXY_HOST_WHITELIST.some(re => re.test(hostname))
  } catch {
    return false
  }
}

module.exports = { parseVideo, isAllowedProxyTarget }
