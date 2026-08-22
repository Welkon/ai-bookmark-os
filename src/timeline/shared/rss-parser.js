// shared/rss-parser.js
// RSS 2.0 / Atom / JSON Feed 统一解析器
// 不依赖 DOMParser，兼容 service worker 环境（无 DOM）
//
// 输出结构:
// {
//   title, siteUrl, description,
//   items: [{ guid, title, link, author, publishedAt, summary, contentSnippet, imageUrl }]
// }

(function (global) {
  'use strict';

  // ===== 工具函数 =====

  function decodeEntities(s) {
    if (!s) return '';
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => {
        const code = parseInt(n, 10);
        // fromCodePoint 才能正确处理增补平面字符（如 emoji），fromCharCode 会产出错位代理半区
        return code > 0 ? String.fromCodePoint(code) : '';
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
        const code = parseInt(n, 16);
        return code > 0 ? String.fromCodePoint(code) : '';
      })
      .replace(/&amp;/g, '&'); // 必须最后处理，避免二次解码
  }

  function stripTags(html) {
    if (!html) return '';
    return decodeEntities(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseDate(s) {
    if (!s) return 0;
    const str = String(s).trim();
    const t = Date.parse(str);
    if (!isNaN(t)) return t;
    // 尝试把空格分隔的日期修正为 ISO
    const iso = str.replace(' ', 'T');
    const t2 = Date.parse(iso);
    if (!isNaN(t2)) return t2;
    return 0;
  }

  // 缺 guid/link 的低质量条目：用标题+发布时间的稳定哈希兜底。
  // 之前的 Math.random() 会让每次拉取都判为“新文章”，重复入库并轰炸通知。
  function fallbackItemGuid(title, publishedAt) {
    let hash = 2166136261;
    const text = `item:${title || ''}:${publishedAt || 0}`;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fallback_${(hash >>> 0).toString(36)}`;
  }

  // 提取标签内容（处理 CDATA 与实体），返回第一个匹配的内部文本。
  // 允许可选的命名空间前缀（如 <atom:entry>），且开闭标签前缀必须一致，
  // 否则带命名空间的 Atom（<atom:feed>/<atom:entry>）会解析出 0 条。
  function tagContent(parent, tag) {
    if (!parent) return '';
    const re = new RegExp('<(?:([\\w.-]+):)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\1:)?' + tag + '\\s*>', 'i');
    const m = parent.match(re);
    if (!m) return '';
    let raw = m[2];
    // 处理 CDATA 段（可能有多个）
    raw = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c);
    return raw.trim();
  }

  // 提取所有指定标签块的内容数组（同样容忍命名空间前缀，前缀开闭一致）
  function tagBlocks(parent, tag) {
    if (!parent) return [];
    const re = new RegExp('<(?:([\\w.-]+):)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\1:)?' + tag + '\\s*>', 'gi');
    const blocks = [];
    let m;
    while ((m = re.exec(parent)) !== null) {
      blocks.push(m[2]);
    }
    return blocks;
  }

  // 提取自闭合/带属性的 link 标签的 href，按 rel 过滤
  function collectLinks(parent) {
    if (!parent) return [];
    const links = [];
    const re = /<link\s([^>]*?)(?:\/?)>/gi;
    let m;
    while ((m = re.exec(parent)) !== null) {
      const attrs = m[1] || '';
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
      const relMatch = attrs.match(/rel\s*=\s*["']([^"']*)["']/i);
      const typeMatch = attrs.match(/type\s*=\s*["']([^"']*)["']/i);
      links.push({
        href: hrefMatch ? hrefMatch[1] : '',
        rel: relMatch ? relMatch[1] : '',
        type: typeMatch ? typeMatch[1] : ''
      });
    }
    return links;
  }

  function pickAlternateLink(links) {
    // 优先 rel=alternate，其次无 rel 的 link，最后任意有 href 的
    let alt = links.find(l => l.rel === 'alternate' && l.href);
    if (alt) return alt.href;
    let noRel = links.find(l => !l.rel && l.href);
    if (noRel) return noRel.href;
    let any = links.find(l => l.href);
    return any ? any.href : '';
  }

  function extractChannelBlock(text) {
    const m = text.match(/<channel[\s>][\s\S]*?<\/channel\s*>/i);
    return m ? m[0] : text;
  }

  function extractFeedBlock(text) {
    // 容忍命名空间前缀（<atom:feed>）；未匹配时回退整篇文档，
    // 配合 tagBlocks 的前缀容忍仍能提取 <atom:entry>。
    const m = text.match(/<(?:[\w.-]+:)?feed[\s>][\s\S]*?<\/(?:[\w.-]+:)?feed\s*>/i);
    return m ? m[0] : text;
  }

  // 从 RSS/Atom item 中提取图片 URL，优先级：
  // 1. <enclosure> (RSS) / <link rel="enclosure"> (Atom) type 含 image
  // 2. <media:content> / <media:thumbnail> url 属性
  // 3. <content>/<description>/<summary> HTML 中第一个 <img> 的 src
  function extractImageUrl(itemBlock, contentRaw, descriptionRaw) {
    if (!itemBlock) return '';

    // 1. <enclosure url="..." type="image/...">
    const encRe = /<enclosure\s([^>]*?)(?:\/?)>/gi;
    let em;
    while ((em = encRe.exec(itemBlock)) !== null) {
      const attrs = em[1] || '';
      const urlM = attrs.match(/url\s*=\s*["']([^"']*)["']/i);
      const typeM = attrs.match(/type\s*=\s*["']([^"']*)["']/i);
      if (urlM && urlM[1] && (!typeM || /image/i.test(typeM[1]))) {
        return decodeEntities(urlM[1]);
      }
    }

    // 2. <media:content url="..." ...> / <media:thumbnail url="..." ...>
    const mediaRe = /<media:(content|thumbnail|group)\s([^>]*?)(?:\/?)>/gi;
    let mm;
    while ((mm = mediaRe.exec(itemBlock)) !== null) {
      const attrs = mm[2] || '';
      const urlM = attrs.match(/url\s*=\s*["']([^"']*)["']/i);
      const typeM = attrs.match(/type\s*=\s*["']([^"']*)["']/i);
      if (urlM && urlM[1] && (!typeM || /image/i.test(typeM[1]))) {
        return decodeEntities(urlM[1]);
      }
    }
    // <media:group> 内嵌 <media:content> / <media:thumbnail>
    const groupRe = /<media:group[^>]*>([\s\S]*?)<\/media:group>/gi;
    let gm;
    while ((gm = groupRe.exec(itemBlock)) !== null) {
      const inner = gm[1];
      const innerRe = /<media:(content|thumbnail)\s([^>]*?)(?:\/?)>/gi;
      let im;
      while ((im = innerRe.exec(inner)) !== null) {
        const attrs = im[2] || '';
        const urlM = attrs.match(/url\s*=\s*["']([^"']*)["']/i);
        const typeM = attrs.match(/type\s*=\s*["']([^"']*)["']/i);
        if (urlM && urlM[1] && (!typeM || /image/i.test(typeM[1]))) {
          return decodeEntities(urlM[1]);
        }
      }
    }

    // Atom: <link rel="enclosure" href="..." type="image/...">
    const linkRe = /<link\s([^>]*?)(?:\/?)>/gi;
    let lm;
    while ((lm = linkRe.exec(itemBlock)) !== null) {
      const attrs = lm[1] || '';
      const hrefM = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
      const relM = attrs.match(/rel\s*=\s*["']([^"']*)["']/i);
      const typeM = attrs.match(/type\s*=\s*["']([^"']*)["']/i);
      if (hrefM && hrefM[1] && relM && /enclosure/i.test(relM[1]) && (!typeM || /image/i.test(typeM[1]))) {
        return decodeEntities(hrefM[1]);
      }
    }

    // 3. HTML 内容中第一个 <img src="...">
    const htmlSource = contentRaw || descriptionRaw || '';
    if (htmlSource) {
      // 处理 CDATA
      const decoded = htmlSource.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c);
      const imgM = decoded.match(/<img\s[^>]*?src\s*=\s*["']([^"']*)["']/i);
      if (imgM && imgM[1]) {
        return decodeEntities(imgM[1]);
      }
    }

    return '';
  }

  // ===== RSS 2.0 =====
  function parseRss(text) {
    const channel = extractChannelBlock(text);
    const title = stripTags(tagContent(channel, 'title'));
    const link = decodeEntities(tagContent(channel, 'link').trim());
    const description = stripTags(tagContent(channel, 'description'));
    let itemBlocks = tagBlocks(channel, 'item');
    if (itemBlocks.length === 0) {
      // RSS 1.0 (RDF)：<item> 是 <channel> 的兄弟节点而非子节点。
      // 此前只在 channel 块内找 item，RDF 源解析出 0 条后被误报为“无文章”。
      itemBlocks = tagBlocks(text, 'item');
    }
    const items = itemBlocks.map(item => {
      const guid = decodeEntities(tagContent(item, 'guid').trim());
      const itemTitle = stripTags(tagContent(item, 'title'));
      let itemLink = tagContent(item, 'link').trim();
      if (!itemLink) {
        // 罕见：RSS 中 link 自闭合
        const links = collectLinks(item);
        itemLink = pickAlternateLink(links);
      }
      itemLink = decodeEntities(itemLink);
      const pubDate = parseDate(
        tagContent(item, 'pubDate') ||
        tagContent(item, 'dc:date') ||
        tagContent(item, 'date') ||
        tagContent(item, 'published')
      );
      const author = stripTags(
        tagContent(item, 'author') ||
        tagContent(item, 'dc:creator') ||
        tagContent(item, 'creator')
      );
      const descriptionRaw = tagContent(item, 'description');
      const contentRaw = tagContent(item, 'content:encoded') || tagContent(item, 'content');
      const summary = stripTags(descriptionRaw || contentRaw).slice(0, 500);
      const contentSnippet = stripTags(contentRaw || descriptionRaw).slice(0, 1000);
      const imageUrl = extractImageUrl(item, contentRaw, descriptionRaw);
      return {
        guid: guid || itemLink || itemTitle || fallbackItemGuid(itemTitle, pubDate),
        title: itemTitle,
        link: itemLink,
        author,
        publishedAt: pubDate,
        summary,
        contentSnippet,
        imageUrl
      };
    }).filter(it => it.title || it.link);

    return { title, siteUrl: link, description, items };
  }

  // ===== Atom =====
  function parseAtom(text) {
    const feed = extractFeedBlock(text);
    const title = stripTags(tagContent(feed, 'title'));
    const links = collectLinks(feed);
    const siteUrl = decodeEntities(pickAlternateLink(links));
    const description = stripTags(tagContent(feed, 'subtitle'));

    const entries = tagBlocks(feed, 'entry').map(entry => {
      const eTitle = stripTags(tagContent(entry, 'title'));
      const eLinks = collectLinks(entry);
      const eLink = decodeEntities(pickAlternateLink(eLinks));
      const id = stripTags(tagContent(entry, 'id'));
      const published = parseDate(
        tagContent(entry, 'published') ||
        tagContent(entry, 'updated') ||
        tagContent(entry, 'modified')
      );
      const authorBlock = tagBlocks(entry, 'author')[0] || '';
      const author = stripTags(tagContent(authorBlock || entry, 'name'));
      const summaryRaw = tagContent(entry, 'summary');
      const contentRaw = tagContent(entry, 'content');
      const summary = stripTags(summaryRaw || contentRaw).slice(0, 500);
      const contentSnippet = stripTags(contentRaw || summaryRaw).slice(0, 1000);
      const imageUrl = extractImageUrl(entry, contentRaw, summaryRaw);
      return {
        guid: id || eLink || eTitle || fallbackItemGuid(eTitle, published),
        title: eTitle,
        link: eLink,
        author,
        publishedAt: published,
        summary,
        contentSnippet,
        imageUrl
      };
    }).filter(it => it.title || it.link);

    return { title, siteUrl, description, items: entries };
  }

  // ===== JSON Feed =====
  function parseJsonFeed(text) {
    let json;
    try { json = JSON.parse(text); } catch { return null; }
    if (!json || typeof json !== 'object') return null;

    const title = json.title || '';
    const siteUrl = json.home_page_url || '';
    const description = json.description || '';
    const items = (json.items || []).map(it => {
      const pub = parseDate(it.date_published || it.date_modified);
      const summary = stripTags(it.summary || it.content_text || it.content_html || '').slice(0, 500);
      const contentSnippet = stripTags(it.content_html || it.content_text || it.summary || '').slice(0, 1000);
      const author = (it.authors && it.authors[0] && it.authors[0].name)
        || (it.author && it.author.name)
        || (it.tags && it.tags[0]) // 兜底用 tag
        || '';
      const imageUrl = it.image || it.banner_image || '';
      return {
        guid: it.id || it.url || '',
        title: stripTags(it.title || ''),
        link: it.url || it.external_url || '',
        author,
        publishedAt: pub,
        summary,
        contentSnippet,
        imageUrl
      };
    }).filter(it => it.title || it.link);

    return { title, siteUrl, description, items };
  }

  // ===== 主入口 =====
  function parseFeed(text, contentType) {
    if (!text) return null;
    const ct = (contentType || '').toLowerCase();
    const trimmed = text.trim();

    // JSON Feed
    if (ct.includes('json') || trimmed.startsWith('{')) {
      return parseJsonFeed(trimmed);
    }
    // Atom（容忍命名空间前缀，如 <atom:feed>/<atom:entry>）
    if ( /<(?:[\w.-]+:)?feed[\s>]/i.test(trimmed) || /<(?:[\w.-]+:)?entry[\s>]/i.test(trimmed)) {
      return parseAtom(trimmed);
    }
    // RSS 2.0 / RSS 1.0 (RDF)
    if ( /<(?:[\w.-]+:)?rss[\s>]/i.test(trimmed) || /<channel[\s>]/i.test(trimmed) || /<rdf:RDF[\s>]/i.test(trimmed)) {
      return parseRss(trimmed);
    }
    // 兜底：当作 RSS 尝试
    return parseRss(trimmed);
  }

  // 从 HTML 中嗅探 RSS/Atom feed 链接（用于自动发现）
  function discoverFeedsInHtml(html, baseUrl) {
    if (!html) return [];
    const links = collectLinks(html);
    const feeds = [];
    for (const l of links) {
      const type = (l.type || '').toLowerCase();
      const rel = (l.rel || '').toLowerCase();
      const isFeedType = type.includes('rss') || type.includes('atom') || type.includes('json');
      const isFeedRel = rel === 'alternate';
      if (l.href && isFeedRel && (isFeedType || /feed|rss|atom/i.test(l.href))) {
        try {
          const abs = new URL(l.href, baseUrl).href;
          feeds.push({ url: abs, title: '', type: l.type || '' });
        } catch { /* ignore invalid */ }
      }
    }
    return feeds;
  }

  global.RssParser = {
    parseFeed,
    parseDate,
    stripTags,
    decodeEntities,
    discoverFeedsInHtml
  };
})(typeof self !== 'undefined' ? self : this);
