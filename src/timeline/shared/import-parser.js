// 书签导入解析器：popup 与 settings 共用同一实现，
// 保证两个入口的 HTML/JSON 导入在文件夹结构、时间戳与 URL 白名单上行为一致。
// （此前 popup 用正则解析会丢失 folderPath，导入后全部堆在默认根目录。）
(function (global) {
  'use strict';

  const ROOT_NAMES = new Set([
    '书签栏', '收藏夹栏', '书签菜单', '其他书签', '其他收藏夹', '移动设备书签',
    'bookmarks bar', 'bookmarks menu', 'other bookmarks', 'mobile bookmarks',
  ]);

  function timestamp(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
    return parsed > 1e12 ? parsed : parsed * 1000;
  }

  // 与后台 normalizeUrl 的白名单对齐（仅 http/https/ftp）。
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return /^(https?|ftp):$/.test(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  }

  function parseImportedJSON(text) {
    try {
      const data = JSON.parse(text);
      if (Number(data?.version) === 2 && Array.isArray(data.roots)) {
        const items = [];
        const folderPaths = [];
        const walk = (nodes, path = '') => {
          for (const node of nodes || []) {
            if (!node || typeof node !== 'object') continue;
            if (node.type === 'folder') {
              const title = String(node.title || '').trim();
              const nextPath = !path && ROOT_NAMES.has(title.toLowerCase()) ? '' : [path, title].filter(Boolean).join('/');
              if (nextPath) folderPaths.push(nextPath);
              walk(node.children, nextPath);
            } else if (node.type === 'bookmark' && node.url) {
              const metadata = node.metadata && typeof node.metadata === 'object' ? node.metadata : {};
              items.push({
                ...metadata,
                title: node.title || node.url,
                url: node.url,
                dateAdded: node.dateAdded || Date.now(),
                folderPath: node.folderPath || path,
                tags: Array.isArray(metadata.tags) ? metadata.tags : [],
                pinned: !!metadata.pinned,
              });
            }
          }
        };
        walk(data.roots);
        return { items, folderPaths: [...new Set(folderPaths)] };
      }
      const list = Array.isArray(data) ? data : (data.bookmarks || []);
      const items = list.filter((b) => b && b.url).map((b) => ({
        title: b.title || b.url,
        url: b.url,
        dateAdded: b.dateAdded || Date.now(),
        folderPath: b.folderPath || '',
        tags: Array.isArray(b.tags) ? b.tags : [],
        pinned: !!b.pinned,
      }));
      return { items, folderPaths: [...new Set(items.map((item) => item.folderPath).filter(Boolean))] };
    } catch {
      return null;
    }
  }

  function parseImportedHTML(text) {
    const documentNode = new DOMParser().parseFromString(text, 'text/html');
    const items = [];
    const folderPaths = [];
    const directChild = (element, tagName) => [...element.children].find((child) => child.tagName === tagName) || null;
    const walkList = (list, path = '') => {
      const children = [...list.children];
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (child.tagName === 'DL') {
          walkList(child, path);
          continue;
        }
        if (child.tagName !== 'DT') continue;
        const heading = directChild(child, 'H3');
        const anchor = directChild(child, 'A');
        if (heading) {
          const title = heading.textContent.trim();
          const nextPath = !path && ROOT_NAMES.has(title.toLowerCase()) ? '' : [path, title].filter(Boolean).join('/');
          if (nextPath) folderPaths.push(nextPath);
          let nested = directChild(child, 'DL');
          if (!nested && children[index + 1]?.tagName === 'DL') nested = children[++index];
          if (nested) walkList(nested, nextPath);
          continue;
        }
        if (anchor) {
          const url = safeUrl(anchor.getAttribute('href') || '');
          if (!url) continue;
          items.push({
            title: anchor.textContent.trim() || url,
            url,
            dateAdded: timestamp(anchor.getAttribute('add_date')),
            folderPath: path,
            tags: String(anchor.getAttribute('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
            pinned: false,
          });
        }
      }
    };
    const rootList = documentNode.querySelector('dl');
    if (rootList) walkList(rootList);
    if (!items.length) {
      for (const anchor of documentNode.querySelectorAll('a[href]')) {
        const url = safeUrl(anchor.getAttribute('href') || '');
        if (url) items.push({ title: anchor.textContent.trim() || url, url, dateAdded: timestamp(anchor.getAttribute('add_date')), folderPath: '', tags: [], pinned: false });
      }
    }
    return { items, folderPaths: [...new Set(folderPaths)] };
  }

  global.ImportParser = { parseImportedHTML, parseImportedJSON };
})(typeof window !== 'undefined' ? window : globalThis);
