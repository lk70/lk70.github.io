/**
 * 上传按钮与弹窗（上传到 R2 桶 upload）
 * 由本脚本自动注入按钮和弹窗，页面只需引入 upload.css 与本文件。
 */
(function () {
    if (document.getElementById('uploadBtn')) return;

    var MAX_SIZE = 95 * 1024 * 1024;
    var ALLOWED = ['pdf', 'epub', 'mobi', 'azw3', 'cbz', 'cbr', 'zip', 'rar', '7z', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'txt', 'md', 'json', 'csv', 'mp4', 'webm', 'mp3', 'm4a'];

    var items = [];
    var uploading = false;

    function fmtSize(n) {
        if (!n && n !== 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }

    function extOf(name) {
        var i = name.lastIndexOf('.');
        return i < 0 ? '' : name.slice(i + 1).toLowerCase();
    }

    // ===== 注入按钮 =====
    var btn = document.createElement('button');
    btn.id = 'uploadBtn';
    btn.type = 'button';
    btn.setAttribute('aria-label', '上传文件');
    btn.innerHTML = '<span class="up-btn-arrow">↑</span><span>上传</span>';
    document.body.appendChild(btn);

    // ===== 注入弹窗 =====
    var modal = document.createElement('div');
    modal.id = 'uploadModal';
    modal.innerHTML =
        '<div class="up-panel" role="dialog" aria-modal="true" aria-label="上传文件">' +
        '  <div class="up-head">' +
        '    <span class="up-title">上传文件</span>' +
        '    <button type="button" class="up-close" aria-label="关闭">×</button>' +
        '  </div>' +
        '  <p class="up-tip">上传到 Cloudflare R2 · upload 桶</p>' +
        '  <label class="up-dir-label">目标文件夹（可选）' +
        '    <input class="up-dir" type="text" placeholder="如 comic/2026，留空为根目录" autocomplete="off">' +
        '  </label>' +
        '  <label class="up-drop">' +
        '    <input class="up-input" type="file" multiple hidden>' +
        '    <span class="up-drop-title">点击选择文件，或拖拽到此处</span>' +
        '    <span class="up-drop-hint">单次合计 ≤ 95 MB</span>' +
        '  </label>' +
        '  <div class="up-list"></div>' +
        '  <div class="up-foot">' +
        '    <span class="up-summary"></span>' +
        '    <button type="button" class="up-start" disabled>开始上传</button>' +
        '  </div>' +
        '</div>';
    document.body.appendChild(modal);

    var panel = modal.querySelector('.up-panel');
    var closeBtn = modal.querySelector('.up-close');
    var dirInput = modal.querySelector('.up-dir');
    var dropZone = modal.querySelector('.up-drop');
    var fileInput = modal.querySelector('.up-input');
    var listEl = modal.querySelector('.up-list');
    var summaryEl = modal.querySelector('.up-summary');
    var startBtn = modal.querySelector('.up-start');

    function openModal() {
        modal.classList.add('open');
        document.body.classList.add('up-locked');
        dirInput.focus();
    }

    function closeModal() {
        if (uploading) return;
        modal.classList.remove('open');
        document.body.classList.remove('up-locked');
    }

    btn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) {
        if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });

    // ===== 选择与拖拽 =====
    function updateStart() {
        var pending = items.filter(function (it) { return it.status === 'pending'; }).length;
        startBtn.disabled = uploading || pending === 0;
        if (!uploading) {
            startBtn.textContent = pending ? '开始上传（' + pending + '）' : '开始上传';
        }
    }

    function setStatus(it, text, type) {
        it.statusEl.textContent = text;
        it.statusEl.className = 'up-status' + (type ? ' ' + type : '');
    }

    function addFile(file) {
        var name = file.name;
        var ext = extOf(name);

        var item = document.createElement('div');
        item.className = 'up-item';

        var head = document.createElement('div');
        head.className = 'up-item-head';

        var nameEl = document.createElement('span');
        nameEl.className = 'up-name';
        nameEl.textContent = name;
        nameEl.title = name;

        var meta = document.createElement('span');
        meta.className = 'up-meta';
        meta.textContent = fmtSize(file.size);

        var statusEl = document.createElement('span');
        statusEl.className = 'up-status';
        statusEl.textContent = '等待上传';

        head.appendChild(nameEl);
        head.appendChild(meta);
        head.appendChild(statusEl);

        var barWrap = document.createElement('div');
        barWrap.className = 'up-bar';
        var bar = document.createElement('i');
        barWrap.appendChild(bar);

        item.appendChild(head);
        item.appendChild(barWrap);
        listEl.appendChild(item);

        var it = {
            file: file,
            el: item,
            barEl: bar,
            statusEl: statusEl,
            status: 'pending',
        };

        // 本地预校验
        if (!ALLOWED.includes(ext)) {
            it.status = 'error';
            setStatus(it, ext ? '不支持 .' + ext : '缺少扩展名', 'error');
            barWrap.style.display = 'none';
        } else if (file.size === 0) {
            it.status = 'error';
            setStatus(it, '空文件', 'error');
            barWrap.style.display = 'none';
        } else if (file.size > MAX_SIZE) {
            it.status = 'error';
            setStatus(it, '超过 95 MB', 'error');
            barWrap.style.display = 'none';
        }

        // 同名同大小视为重复，直接忽略
        var dup = items.some(function (x) {
            return x.file.name === file.name && x.file.size === file.size;
        });
        if (dup) {
            item.parentNode.removeChild(item);
            return;
        }

        items.push(it);
        updateStart();
    }

    fileInput.addEventListener('change', function () {
        Array.prototype.forEach.call(fileInput.files, addFile);
        fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) {
            e.preventDefault();
            dropZone.classList.add('dragging');
        });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) {
            e.preventDefault();
            dropZone.classList.remove('dragging');
        });
    });
    dropZone.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) {
            Array.prototype.forEach.call(e.dataTransfer.files, addFile);
        }
    });

    // ===== 上传 =====
    function uploadOne(it, dir, done) {
        var form = new FormData();
        if (dir) form.append('dir', dir);
        form.append('file', it.file, it.file.name);

        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');

        xhr.upload.onprogress = function (e) {
            if (!e.lengthComputable) return;
            var pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
            it.barEl.style.width = pct + '%';
            setStatus(it, '上传中 ' + pct + '%', 'uploading');
        };

        xhr.onload = function () {
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) {}

            if (xhr.status === 200 && data && data.uploaded && data.uploaded.length) {
                it.status = 'done';
                it.barEl.style.width = '100%';
                setStatus(it, '✓ 已上传', 'done');
                var info = data.uploaded[0];
                if (info && info.key) {
                    var link = document.createElement('a');
                    link.className = 'up-link';
                    // 统一走站点代理，避免暴露 R2 裸直链
                    link.href = '/api/file?bucket=upload&key=' + encodeURIComponent(info.key);
                    link.target = '_blank';
                    link.rel = 'noopener';
                    link.textContent = '打开';
                    it.statusEl.appendChild(link);
                }
            } else {
                var msg = (data && (data.error || (data.failed && data.failed[0] && data.failed[0].error))) ||
                    (xhr.status === 413 ? '文件过大（HTTP 413）' : 'HTTP ' + xhr.status);
                it.status = 'error';
                setStatus(it, '✗ ' + msg, 'error');
                it.el.classList.add('failed');
            }
            done();
        };

        xhr.onerror = function () {
            it.status = 'error';
            setStatus(it, '✗ 网络错误', 'error');
            it.el.classList.add('failed');
            done();
        };

        xhr.send(form);
    }

    startBtn.addEventListener('click', function () {
        if (uploading) return;
        var pending = items.filter(function (it) { return it.status === 'pending'; });
        if (!pending.length) return;

        uploading = true;
        startBtn.disabled = true;
        startBtn.textContent = '上传中…';
        closeBtn.disabled = true;
        summaryEl.textContent = '';

        var dir = dirInput.value.trim().replace(/^\/+|\/+$/g, '');
        var index = 0;

        function next() {
            if (index >= pending.length) {
                uploading = false;
                closeBtn.disabled = false;
                var ok = items.filter(function (it) { return it.status === 'done'; }).length;
                var bad = items.filter(function (it) { return it.status === 'error'; }).length;
                summaryEl.textContent = '成功 ' + ok + ' 个，失败 ' + bad + ' 个';
                summaryEl.className = 'up-summary' + (bad ? ' has-error' : '');
                updateStart();
                return;
            }
            uploadOne(pending[index++], dir, next);
        }

        next();
    });

    updateStart();
})();
