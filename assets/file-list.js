/**
 * R2 目录树（嵌套展示）
 * 自动初始化 .list-section[data-prefix]，点击文件夹在原位展开子目录并懒加载。
 * 数据来自 /api/list（delimiter 分层）。
 */
(function () {
    var PAGE_SIZE = 200;
    var section = document.querySelector('.list-section[data-prefix]');
    if (!section) return;

    var prefix = section.dataset.prefix;
    var treeEl = section.querySelector('.tree');
    var countEl = section.querySelector('.count');
    if (!treeEl) return;

    var rootFolderCount = 0;
    var rootFileCount = 0;

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

    // 同一目录的响应只请求一次（折叠后再展开、悬停预取都复用）
    var requestCache = Object.create(null);

    function fetchPage(path, cursor) {
        var key = path + '|' + (cursor || '');
        if (requestCache[key]) return requestCache[key];

        var params = new URLSearchParams();
        params.set('prefix', prefix);
        params.set('limit', String(PAGE_SIZE));
        if (path) params.set('path', path);
        if (cursor) params.set('cursor', cursor);

        var p = fetch('/api/list?' + params.toString()).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
                return data;
            });
        });

        requestCache[key] = p;
        p.catch(function () {
            if (requestCache[key] === p) delete requestCache[key];
        });
        return p;
    }

    function updateCount() {
        var parts = [];
        if (rootFolderCount) parts.push(rootFolderCount + ' 个文件夹');
        if (rootFileCount) parts.push(rootFileCount + ' 个文件');
        countEl.textContent = parts.length ? parts.join(' · ') : '';
    }

    function fileRow(obj, depth) {
        var a = document.createElement('a');
        a.className = 'file-row';
        a.href = obj.url || ('/api/file?key=' + encodeURIComponent(obj.key));
        a.target = '_blank';
        a.rel = 'noopener';
        a.style.paddingLeft = (18 + depth * 20 + 22) + 'px';

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

    function folderNode(folder, depth) {
        var block = document.createElement('div');
        block.className = 'folder-block';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'file-row folder-row';
        btn.style.paddingLeft = (18 + depth * 20) + 'px';
        btn.setAttribute('aria-expanded', 'false');

        var arrow = document.createElement('span');
        arrow.className = 'folder-arrow';
        arrow.textContent = '▸';

        var icon = document.createElement('span');
        icon.className = 'badge folder-badge';
        icon.textContent = '📁';

        var name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = folder.name;
        name.title = folder.path;

        btn.appendChild(arrow);
        btn.appendChild(icon);
        btn.appendChild(name);

        var children = document.createElement('div');
        children.className = 'folder-children';
        children.hidden = true;

        var prefetchTimer = null;
        function prefetch() {
            if (block.dataset.loaded) return;
            clearTimeout(prefetchTimer);
            prefetchTimer = setTimeout(function () {
                fetchPage(folder.path, null).catch(function () {});
            }, 120);
        }
        btn.addEventListener('pointerenter', prefetch);
        btn.addEventListener('focus', prefetch);
        btn.addEventListener('pointerleave', function () { clearTimeout(prefetchTimer); });

        btn.addEventListener('click', function () {
            var open = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', open ? 'false' : 'true');
            arrow.classList.toggle('open', !open);
            children.hidden = open;
            if (!open && !block.dataset.loaded) {
                block.dataset.loaded = '1';
                createLevel(children, folder.path, depth + 1);
            }
        });

        block.appendChild(btn);
        block.appendChild(children);
        return block;
    }

    function createLevel(container, path, depth) {
        var level = document.createElement('div');
        level.className = 'level';

        var foldersEl = document.createElement('div');
        foldersEl.className = 'level-folders';
        var filesEl = document.createElement('div');
        filesEl.className = 'level-files';

        var emptyEl = document.createElement('div');
        emptyEl.className = 'state';
        emptyEl.style.paddingLeft = (18 + depth * 20) + 'px';
        emptyEl.textContent = '加载中…';

        var moreWrap = document.createElement('div');
        moreWrap.className = 'more-wrap';
        var moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'more-btn';
        moreBtn.textContent = '加载更多';
        moreWrap.appendChild(moreBtn);
        moreWrap.style.display = 'none';

        level.appendChild(foldersEl);
        level.appendChild(filesEl);
        level.appendChild(emptyEl);
        level.appendChild(moreWrap);
        container.appendChild(level);

        var st = { cursor: null, done: false, loading: false, seen: {}, count: 0 };

        function setEmpty(text) {
            emptyEl.textContent = text;
            emptyEl.style.display = 'block';
        }

        function load(reset) {
            if (reset) {
                st.cursor = null;
                st.done = false;
                st.loading = false;
                st.seen = {};
                st.count = 0;
                foldersEl.textContent = '';
                filesEl.textContent = '';
                setEmpty('加载中…');
                moreWrap.style.display = 'none';
            }
            if (st.loading || st.done) return;

            st.loading = true;
            moreBtn.disabled = true;
            moreBtn.textContent = '加载中…';

            fetchPage(path, st.cursor)
                .then(function (data) {
                    var folders = (data.folders || []).slice().sort(function (a, b) {
                        return a.name.localeCompare(b.name, 'zh-Hans-CN');
                    });
                    folders.forEach(function (folder) {
                        if (st.seen['d:' + folder.path]) return;
                        st.seen['d:' + folder.path] = true;
                        foldersEl.appendChild(folderNode(folder, depth));
                        st.count += 1;
                        if (depth === 0) rootFolderCount += 1;
                    });

                    var objects = data.objects || [];
                    if (objects.length) {
                        var frag = document.createDocumentFragment();
                        objects.forEach(function (obj) {
                            if (st.seen['f:' + obj.key]) return;
                            st.seen['f:' + obj.key] = true;
                            frag.appendChild(fileRow(obj, depth));
                            st.count += 1;
                            if (depth === 0) rootFileCount += 1;
                        });
                        filesEl.appendChild(frag);
                    }

                    st.cursor = data.cursor || null;
                    st.done = !data.truncated || !st.cursor;

                    if (st.count === 0) {
                        setEmpty('此目录为空');
                    } else {
                        emptyEl.style.display = 'none';
                    }
                    moreWrap.style.display = st.done ? 'none' : 'block';
                    if (depth === 0) updateCount();
                })
                .catch(function (err) {
                    setEmpty('加载失败：' + err.message + '（请确认 Pages 项目已配置 R2 绑定）');
                    moreWrap.style.display = 'none';
                })
                .then(function () {
                    st.loading = false;
                    moreBtn.disabled = false;
                    moreBtn.textContent = '加载更多';
                });
        }

        moreBtn.addEventListener('click', function () { load(false); });
        load(true);
    }

    createLevel(treeEl, '', 0);
})();
