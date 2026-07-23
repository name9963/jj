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
  } else if (cleanUrl.includes('xiaohongshu.com') || cleanUrl.includes('xhslink.com')) {
    return parseXiaohongshu(cleanUrl)
  } else if (cleanUrl.includes('weibo.com') || cleanUrl.includes('weibo.cn')) {
    return parseWeibo(cleanUrl)
  } else if (cleanUrl.includes('pipix.com')) {
    return parsePipix(cleanUrl)
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
 */
async function parseDouyin(url) {
  // 短链接先获取重定向
  const realUrl = await getRedirectUrl(url)

  // 提取视频ID
  const idMatch = realUrl.match(/video\/(\d+)/) || realUrl.match(/modal_id=(\d+)/)
  if (!idMatch) throw new Error('无法解析抖音视频ID')

  const videoId = idMatch[1]

  // 通过网页接口获取视频信息
  const apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`
  const res = await axios.get(apiUrl, { headers: HEADERS })

  const item = res.data.item_list && res.data.item_list[0]
  if (!item) throw new Error('视频不存在或已被删除')

  // 获取无水印视频地址
  let videoUrl = item.video.play_addr.url_list[0]
  // 替换为无水印地址
  videoUrl = videoUrl.replace('playwm', 'play')

  return {
    videoUrl,
    cover: item.video.cover.url_list[0] || '',
    title: item.desc || '抖音视频'
  }
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
 * 小红书解析
 */
async function parseXiaohongshu(url) {
  const realUrl = await getRedirectUrl(url)

  const res = await axios.get(realUrl, {
    headers: { ...HEADERS, Referer: 'https://www.xiaohongshu.com/' }
  })

  const html = res.data

  // 提取视频地址
  const videoMatch = html.match(/"originVideoKey"\s*:\s*"([^"]+)"/) ||
                     html.match(/"url"\s*:\s*"(https:\/\/sns-video[^"]+)"/)

  const coverMatch = html.match(/"cover"\s*:\s*{\s*"url"\s*:\s*"([^"]+)"/)
  const titleMatch = html.match(/"title"\s*:\s*"([^"]+)"/)

  if (!videoMatch) throw new Error('无法解析小红书视频，可能是图文笔记')

  let videoUrl = videoMatch[1]
  if (!videoUrl.startsWith('http')) {
    videoUrl = `https://sns-video-bd.xhscdn.com/${videoUrl}`
  }

  return {
    videoUrl,
    cover: coverMatch ? coverMatch[1] : '',
    title: titleMatch ? titleMatch[1] : '小红书视频'
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

module.exports = { parseVideo }
