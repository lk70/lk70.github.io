/**
 * R2 文件清单渲染
 * 在含 .list-section[data-prefix] 的页面自动初始化，数据来自 /api/list。
 */
(function () {
    var PAGE_SIZE = 200;
    var states = {};

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

    function makeRow(obj) {
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

    function load(section, reset) {
        var prefix = section.dataset.prefix;
        var listEl = section.querySelector('.file-list');
        var countEl = section.querySelector('.count');
        var moreWrap = section.querySelector('.more-wrap');
        var moreBtn = section.querySelector('.more-btn');
        var st = states[prefix] || (states[prefix] = { cursor: null, loaded: 0, done: false, loading: false });

        if (reset) {
            st.cursor = null;
            st.loaded = 0;
            st.done = false;
            listEl.innerHTML = '<div class="state">加载中…</div>';
            countEl.textContent = '';
            moreWrap.style.display = 'none';
        }
        if (st.loading || st.done) return;

        st.loading = true;
        moreBtn.disabled = true;
        moreBtn.textContent = '加载中…';

        var params = new URLSearchParams();
        params.set('prefix', prefix);
        params.set('limit', String(PAGE_SIZE));
        if (st.cursor) params.set('cursor', st.cursor);

        fetch('/api/list?' + params.toString())
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
                    return data;
                });
            })
            .then(function (data) {
                if (reset) listEl.innerHTML = '';
                var objects = data.objects || [];
                if (objects.length === 0 && st.loaded === 0) {
                    listEl.innerHTML = '<div class="state">暂无文件</div>';
                } else {
                    var frag = document.createDocumentFragment();
                    objects.forEach(function (obj) { frag.appendChild(makeRow(obj)); });
                    listEl.appendChild(frag);
                    st.loaded += objects.length;
                }
                st.cursor = data.cursor || null;
                st.done = !data.truncated || !st.cursor;
                countEl.textContent = st.loaded ? ('已显示 ' + st.loaded + ' 项' + (st.done ? '' : '，可继续加载')) : '';
                moreWrap.style.display = st.done || st.loaded === 0 ? 'none' : 'block';
            })
            .catch(function (err) {
                if (reset) listEl.innerHTML = '';
                var msg = document.createElement('div');
                msg.className = 'state';
                msg.textContent = '清单加载失败：' + err.message + '（请确认 Pages 项目已配置 R2 绑定）';
                listEl.appendChild(msg);
                moreWrap.style.display = 'none';
            })
            .then(function () {
                st.loading = false;
                moreBtn.disabled = false;
                moreBtn.textContent = '加载更多';
            });
    }

    var sections = document.querySelectorAll('.list-section[data-prefix]');
    Array.prototype.forEach.call(sections, function (section) {
        section.querySelector('.more-btn').addEventListener('click', function () {
            load(section, false);
        });
        load(section, true);
    });
})();
