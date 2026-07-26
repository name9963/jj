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

  if (cleanUrl.includes('douyin.com') || cleanUrl.includes('iesdouyin.com')) {
    return parseDouyin(cleanUrl)
  } else if (cleanUrl.includes('kuaishou.com') || cleanUrl.includes('gifshow.com')) {
    return parseKuaishou(cleanUrl)
  } else if (cleanUrl.includes('xiaohongshu.com') || cleanUrl.includes('xhslink.com') || cleanUrl.includes('xhslink.cn')) {
    return parseXiaohongshu(cleanUrl)
  } else if (cleanUrl.includes('weibo.com') || cleanUrl.includes('weibo.cn')) {
    return parseWeibo(cleanUrl)
  } else if (cleanUrl.includes('pipix.com')) {
    return parsePipix(cleanUrl)
  } else if (cleanUrl.includes('bilibili.com') || cleanUrl.includes('b23.tv')) {
    return parseBilibili(cleanUrl)
  } else {
    // 尝试通用解析
    return parseGeneric(cleanUrl)
  }
}

/**
 * 从分享文本中提取URL
 */
function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>"']+/)
  return match ? match[0] : null
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
  const realUrl = await getRedirectUrl(url)

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

  // 图文作品(aweme_type=68 等)：images 非空，取第一张图返回(封面即结果图)
  if (item.images && item.images.length > 0) {
    const imageUrl = pickImageUrl(item.images[0].url_list)
    return { videoUrl: imageUrl, cover: imageUrl, title, isImage: true }
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
 * 快手解析
 */
async function parseKuaishou(url) {
  const realUrl = await getRedirectUrl(url)

  const res = await axios.get(realUrl, {
    headers: { ...HEADERS, Referer: 'https://www.kuaishou.com/' }
  })

  const html = res.data

  // 从页面中提取视频数据（兼容新旧版页面结构）
  const videoMatch = html.match(/"url"\s*:\s*"(https?:\/\/[^"]*\.mp4[^"]*)"/) ||
                     html.match(/"playUrl"\s*:\s*"([^"]+)"/) ||
                     html.match(/"srcNoMark"\s*:\s*"([^"]+)"/) ||
                     html.match(/"photoUrl"\s*:\s*"([^"]+)"/)

  const coverMatch = html.match(/"coverUrl"\s*:\s*"([^"]+)"/) ||
                     html.match(/"poster"\s*:\s*"(https?:\/\/[^"]+)"/)
  const titleMatch = html.match(/"caption"\s*:\s*"([^"]+)"/)

  if (!videoMatch) throw new Error('无法解析快手视频')

  return {
    videoUrl: videoMatch[1].replace(/\\u002F/g, '/'),
    cover: coverMatch ? coverMatch[1].replace(/\\u002F/g, '/') : '',
    title: titleMatch ? titleMatch[1] : '快手视频'
  }
}

/**
 * 小红书解析。
 * 页面里 sns-video 域名字符串会出现多次(推荐位/相关笔记等无关数据也含有)，
 * 用全局正则"随便抓一个"拿到的地址可能跟当前笔记完全无关；
 * 改为从页面内嵌的 window.__INITIAL_STATE__ 里按 noteData.data.noteData
 * 精确取当前这条笔记的数据，笔记类型(note.type)为 "video" 才继续，否则是图文笔记直接报错。
 */
async function parseXiaohongshu(url) {
  const realUrl = await getRedirectUrl(url)

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
  const realUrl = await getRedirectUrl(url)

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
 * 皮皮虾解析
 */
async function parsePipix(url) {
  const realUrl = await getRedirectUrl(url)

  const res = await axios.get(realUrl, { headers: HEADERS })
  const html = res.data

  const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/)
  const titleMatch = html.match(/"content"\s*:\s*"([^"]+)"/)

  if (!videoMatch) throw new Error('无法解析皮皮虾视频')

  return {
    videoUrl: videoMatch[1].replace(/\\u002F/g, '/'),
    cover: '',
    title: titleMatch ? titleMatch[1] : '皮皮虾视频'
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
  const realUrl = url.includes('b23.tv') ? await getRedirectUrl(url) : url

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

/**
 * 通用解析（尝试从页面meta标签提取）
 */
async function parseGeneric(url) {
  const res = await axios.get(url, { headers: HEADERS })
  const html = res.data

  // 尝试 og:video 标签
  const ogVideo = html.match(/property="og:video"\s+content="([^"]+)"/) ||
                  html.match(/name="og:video"\s+content="([^"]+)"/)
  const ogImage = html.match(/property="og:image"\s+content="([^"]+)"/)
  const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/)

  if (ogVideo) {
    return {
      videoUrl: ogVideo[1],
      cover: ogImage ? ogImage[1] : '',
      title: ogTitle ? ogTitle[1] : '视频'
    }
  }

  throw new Error('暂不支持该平台，请使用抖音、快手、小红书等主流平台链接')
}

/** 代理端点用：只允许转发 B 站官方 CDN 域名，防止被当成任意地址的匿名代理(SSRF) */
function isAllowedProxyTarget(urlStr) {
  try {
    const { hostname, protocol } = new URL(urlStr)
    return protocol === 'https:' && /(^|\.)bilivideo\.com$/.test(hostname)
  } catch {
    return false
  }
}

module.exports = { parseVideo, isAllowedProxyTarget }
