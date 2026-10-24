/**
 * R2 目录浏览器
 * 在含 .list-section[data-prefix] 的页面自动初始化，按 ?path= 参数逐层浏览子文件夹。
 * 数据来自 /api/list（delimiter 分层）。
 */
(function () {
    var PAGE_SIZE = 200;
    var section = document.querySelector('.list-section[data-prefix]');
    if (!section) return;

    var prefix = section.dataset.prefix;
    var rootName = prefix === 'comic' ? '连环画' : (prefix === 'oldbook' ? '古籍' : prefix);

    function readPath() {
        return (new URLSearchParams(location.hash.slice(1)).get('path') || '').replace(/^\/+|\/+$/g, '');
    }

    var path = readPath();

    var statusEl = section.querySelector('.status');
    var statusText = section.querySelector('.status .state');
    var foldersEl = section.querySelector('.folders');
    var filesEl = section.querySelector('.files');
    var countEl = section.querySelector('.count');
    var titleEl = section.querySelector('.dir-title');
    var crumbEl = section.querySelector('.breadcrumb');
    var moreWrap = section.querySelector('.more-wrap');
    var moreBtn = section.querySelector('.more-btn');

    var state = { cursor: null, files: 0, folders: 0, done: false, loading: false };
    var seenFolders = {};

    function fmtSize(n) {
        if (!n && n !== 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }

    function extOf(name) {
        var i = name.lastIndexOf('.');
        if (i < 0 || i === name.length - 1) return 'FILE';
        return name.slice(i + 1).toUpperCase().slice(0, 4);
    }

    function setStatus(text) {
        statusText.textContent = text;
        statusEl.style.display = 'block';
    }

    function hideStatus() {
        statusEl.style.display = 'none';
    }

    function setCount() {
        var parts = [];
        if (state.folders) parts.push(state.folders + ' 个文件夹');
        if (state.files) parts.push(state.files + ' 个文件');
        var text = parts.length ? parts.join(' · ') : '空目录';
        if (!state.done) text += ' · 可继续加载';
        countEl.textContent = text;
    }

    function makeCrumb(label, href) {
        var el = document.createElement(href ? 'a' : 'span');
        el.className = 'crumb' + (href ? '' : ' current');
        if (href) el.href = href;
        el.textContent = label;
        return el;
    }

    function renderBreadcrumb() {
        crumbEl.textContent = '';
        crumbEl.appendChild(makeCrumb(rootName, path ? prefix + '.html' : null));

        var segments = path ? path.split('/') : [];
        var acc = '';
        segments.forEach(function (seg, i) {
            acc = acc ? acc + '/' + seg : seg;
            var sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.textContent = '›';
            crumbEl.appendChild(sep);
            crumbEl.appendChild(makeCrumb(seg, i === segments.length - 1 ? null : '#path=' + encodeURIComponent(acc)));
        });

        titleEl.textContent = segments.length ? segments[segments.length - 1] : '全部文件';
    }

    function folderRow(folder) {
        var a = document.createElement('a');
        a.className = 'file-row folder-row';
        a.href = '#path=' + encodeURIComponent(folder.path);

        var icon = document.createElement('span');
        icon.className = 'badge folder-badge';
        icon.textContent = '📁';

        var name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = folder.name;
        name.title = folder.name;

        var enter = document.createElement('span');
        enter.className = 'folder-enter';
        enter.textContent = '进入 ›';

        a.appendChild(icon);
        a.appendChild(name);
        a.appendChild(enter);
        return a;
    }

    function fileRow(obj) {
        var a = document.createElement('a');
        a.className = 'file-row';
        a.href = obj.url || ('/api/file?key=' + encodeURIComponent(obj.key));
        a.target = '_blank';
        a.rel = 'noopener';

        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = extOf(obj.name);

        var name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = obj.name;
        name.title = obj.name;

        var size = document.createElement('span');
        size.className = 'file-size';
        size.textContent = fmtSize(obj.size);

        a.appendChild(badge);
        a.appendChild(name);
        a.appendChild(size);
        return a;
    }

    function load(reset) {
        if (reset) {
            state.cursor = null;
            state.files = 0;
            state.folders = 0;
            state.done = false;
            seenFolders = {};
            foldersEl.textContent = '';
            filesEl.textContent = '';
            setStatus('加载中…');
        }
        if (state.loading || state.done) return;

        state.loading = true;
        moreBtn.disabled = true;
        moreBtn.textContent = '加载中…';

        var params = new URLSearchParams();
        params.set('prefix', prefix);
        params.set('limit', String(PAGE_SIZE));
        if (path) params.set('path', path);
        if (state.cursor) params.set('cursor', state.cursor);

        fetch('/api/list?' + params.toString())
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
                    return data;
                });
            })
            .then(function (data) {
                (data.folders || []).forEach(function (folder) {
                    if (seenFolders[folder.path]) return;
                    seenFolders[folder.path] = true;
                    foldersEl.appendChild(folderRow(folder));
                    state.folders += 1;
                });

                var objects = data.objects || [];
                if (objects.length) {
                    var frag = document.createDocumentFragment();
                    objects.forEach(function (obj) { frag.appendChild(fileRow(obj)); });
                    filesEl.appendChild(frag);
                    state.files += objects.length;
                }

                state.cursor = data.cursor || null;
                state.done = !data.truncated || !state.cursor;

                if (state.files === 0 && state.folders === 0) {
                    setStatus('此目录为空');
                } else {
                    hideStatus();
                }
                setCount();
                moreWrap.style.display = state.done ? 'none' : 'block';
            })
            .catch(function (err) {
                if (reset) {
                    foldersEl.textContent = '';
                    filesEl.textContent = '';
                }
                setStatus('清单加载失败：' + err.message + '（请确认 Pages 项目已配置 R2 绑定）');
                moreWrap.style.display = 'none';
            })
            .then(function () {
                state.loading = false;
                moreBtn.disabled = false;
                moreBtn.textContent = '加载更多';
            });
    }

    moreBtn.addEventListener('click', function () { load(false); });
    window.addEventListener('hashchange', function () {
        path = readPath();
        renderBreadcrumb();
        load(true);
    });
    renderBreadcrumb();
    load(true);
})();
