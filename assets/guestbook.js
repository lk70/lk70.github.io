/**
 * 留言板
 * - 留言板页面（存在 .gb-page 时）：完整留言列表 + 发表留言表单
 * - 其它页面：自动在页脚上方注入「最新留言」10 条
 * 点击留言内容即可展开回复表单。
 */
(function () {
    'use strict';

    var API = '/api/guestbook';
    var NAME_KEY = 'gb_name';
    var MAX_NAME = 20;
    var MAX_CONTENT = 500;
    var pickerSeq = 0;

    var pageEl = document.querySelector('.gb-page');

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function fmtTime(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
            ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function savedName() {
        try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
    }

    function rememberName(name) {
        try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* 隐私模式忽略 */ }
    }

    function fetchMessages(limit) {
        var params = new URLSearchParams();
        if (limit) params.set('limit', String(limit));
        params.set('_', String(Date.now())); // 绕过边缘缓存，保证刚发的留言立刻可见
        return fetch(API + '?' + params.toString(), { headers: { Accept: 'application/json' } })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
                    return data;
                });
            });
    }

    function postMessage(name, content, parentId, image) {
        var headers = { Accept: 'application/json' };
        var body;

        if (image) {
            body = new FormData();
            body.append('name', name);
            body.append('content', content);
            if (parentId) body.append('parentId', parentId);
            body.append('image', image, image.name || 'image.jpg');
        } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify({ name: name, content: content, parentId: parentId || null });
        }

        return fetch(API, { method: 'POST', headers: headers, body: body })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
                    return data;
                });
            });
    }

    /* ===== 图片：超过 800 KB 自动压缩为 JPG ===== */

    var IMAGE_LIMIT = 800 * 1024;
    var IMAGE_INPUT_MAX = 20 * 1024 * 1024;
    var IMAGE_KEEP_TYPES = /^image\/(jpeg|png|webp|gif)$/i;

    function fmtSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function loadImageSource(file) {
        if (typeof createImageBitmap === 'function') {
            return createImageBitmap(file).catch(function () {
                return loadImageElement(file);
            });
        }
        return loadImageElement(file);
    }

    function loadImageElement(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = function () {
                URL.revokeObjectURL(url);
                reject(new Error('图片读取失败'));
            };
            img.src = url;
        });
    }

    function canvasToJpeg(canvas, quality) {
        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error('图片压缩失败'));
            }, 'image/jpeg', quality);
        });
    }

    /** 用 Canvas 转 JPG，逐步降低质量/尺寸，直到小于 800 KB */
    function compressToJpeg(file) {
        return loadImageSource(file).then(function (source) {
            var sw = source.width || source.naturalWidth;
            var sh = source.height || source.naturalHeight;
            if (!sw || !sh) throw new Error('图片读取失败');

            var canvas = document.createElement('canvas');
            var ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('当前浏览器不支持图片压缩');

            // 超长边先等比缩到 2560 以内，避免超大图占用过多内存
            var scale = Math.min(1, 2560 / Math.max(sw, sh));
            var width = sw * scale;
            var height = sh * scale;
            var quality = 0.85;
            var steps = 0;

            function attempt() {
                canvas.width = Math.max(1, Math.round(width));
                canvas.height = Math.max(1, Math.round(height));
                // 透明背景转 JPG 会变黑，先铺白底
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

                return canvasToJpeg(canvas, quality).then(function (blob) {
                    if (blob.size <= IMAGE_LIMIT) return blob;
                    steps++;
                    if (steps > 24) return blob;
                    if (quality > 0.5) {
                        quality = Math.max(0.5, quality - 0.1);
                    } else {
                        width *= 0.85;
                        height *= 0.85;
                        if (Math.max(width, height) < 320) return blob;
                    }
                    return attempt();
                });
            }

            return attempt();
        });
    }

    function toFile(blob, name) {
        try {
            return new File([blob], name, { type: 'image/jpeg' });
        } catch (e) {
            blob.name = name;
            return blob;
        }
    }

    /** 返回 { file, compressed }：未超限且格式支持时保留原图 */
    function prepareImage(file) {
        if (IMAGE_KEEP_TYPES.test(file.type) && file.size <= IMAGE_LIMIT) {
            return Promise.resolve({ file: file, compressed: false });
        }
        return compressToJpeg(file).then(function (blob) {
            if (blob.size > IMAGE_LIMIT) {
                throw new Error('图片压缩后仍超过 800 KB，请换一张');
            }
            var name = String(file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
            return { file: toFile(blob, name), compressed: true };
        });
    }

    /**
     * 图片选择器
     * 返回 { element, file, busy, reset }：file 为最终要提交的图片（可能已压缩）
     */
    function createImagePicker(setTip) {
        var root = el('div', 'gb-pick');

        var bar = el('div', 'gb-pick-bar');
        var slot = el('span', 'gb-pick-slot');

        var fileId = 'gbFile' + (++pickerSeq);
        var addBtn = el('label', 'gb-pick-btn', '＋ 添加图片');
        addBtn.htmlFor = fileId;
        var input = document.createElement('input');
        input.type = 'file';
        input.id = fileId;
        input.accept = 'image/*';
        input.className = 'gb-file';
        input.setAttribute('aria-label', '选择图片');
        slot.appendChild(addBtn);
        slot.appendChild(input);

        var info = el('span', 'gb-pick-info', '可选，超过 800 KB 自动压缩为 JPG');
        var clearBtn = el('button', 'gb-pick-clear', '移除图片');
        clearBtn.type = 'button';
        clearBtn.hidden = true;

        bar.appendChild(slot);
        bar.appendChild(info);
        bar.appendChild(clearBtn);

        var preview = el('div', 'gb-preview');
        var previewImg = document.createElement('img');
        previewImg.className = 'gb-preview-img';
        previewImg.alt = '图片预览';
        preview.appendChild(previewImg);
        preview.hidden = true;

        root.appendChild(bar);
        root.appendChild(preview);

        var objectUrl = '';
        var picker = { element: root, file: null, busy: false, reset: reset };

        function setInfo(text, ok) {
            info.textContent = text;
            info.className = 'gb-pick-info' + (ok ? ' ok' : '');
        }

        function clearPreview() {
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
                objectUrl = '';
            }
            previewImg.removeAttribute('src');
            preview.hidden = true;
        }

        function reset() {
            clearPreview();
            picker.file = null;
            picker.busy = false;
            clearBtn.hidden = true;
            input.value = '';
            setInfo('可选，超过 800 KB 自动压缩为 JPG');
        }

        clearBtn.addEventListener('click', function () {
            reset();
            setTip('');
        });

        input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            if (!file) return;

            if (!/^image\//i.test(file.type)) {
                setTip('请选择图片文件');
                input.value = '';
                return;
            }
            if (file.size > IMAGE_INPUT_MAX) {
                setTip('图片不能超过 ' + fmtSize(IMAGE_INPUT_MAX));
                input.value = '';
                return;
            }

            picker.busy = true;
            picker.file = null;
            clearBtn.hidden = true;
            setInfo('正在处理图片…');
            setTip('');

            prepareImage(file).then(function (out) {
                picker.busy = false;
                picker.file = out.file;

                clearPreview();
                objectUrl = URL.createObjectURL(out.file);
                previewImg.src = objectUrl;
                preview.hidden = false;
                clearBtn.hidden = false;

                if (out.compressed) {
                    setInfo('已压缩为 JPG：' + fmtSize(file.size) + ' → ' + fmtSize(out.file.size), true);
                } else {
                    setInfo('已选择：' + fmtSize(out.file.size) + '（' + (out.file.type || 'image') + '）', true);
                }
            }).catch(function (err) {
                picker.busy = false;
                picker.file = null;
                input.value = '';
                clearPreview();
                setInfo('可选，超过 800 KB 自动压缩为 JPG');
                setTip(err.message || '图片处理失败');
            });
        });

        return picker;
    }

    /** 回复表单：parentId 为被回复的顶层留言 id */
    function makeReplyForm(parentId, onSuccess, close) {
        var form = document.createElement('form');
        form.className = 'gb-reply-form';

        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'gb-input';
        nameInput.maxLength = MAX_NAME;
        nameInput.autocomplete = 'nickname';
        nameInput.placeholder = '用户名（必填）';
        nameInput.value = savedName();

        var contentInput = document.createElement('textarea');
        contentInput.className = 'gb-textarea gb-reply-textarea';
        contentInput.rows = 3;
        contentInput.maxLength = MAX_CONTENT;
        contentInput.placeholder = '回复内容（有图片时可留空）…';

        var foot = el('div', 'gb-form-foot');
        var tip = el('span', 'gb-tip');
        var cancel = el('button', 'gb-cancel', '取消');
        cancel.type = 'button';
        cancel.addEventListener('click', close);
        var send = el('button', 'gb-submit gb-small', '发送回复');
        send.type = 'submit';
        foot.appendChild(tip);
        foot.appendChild(cancel);
        foot.appendChild(send);

        form.appendChild(nameInput);
        form.appendChild(contentInput);

        function setTip(text) {
            tip.textContent = text || '';
            tip.className = 'gb-tip' + (text ? ' error' : '');
        }

        var picker = createImagePicker(setTip);
        form.appendChild(picker.element);
        form.appendChild(foot);

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var name = nameInput.value.trim();
            var content = contentInput.value.trim();
            if (!name) { setTip('请填写用户名'); nameInput.focus(); return; }
            if (picker.busy) { setTip('图片处理中，请稍候'); return; }
            if (!content && !picker.file) {
                setTip('请填写回复内容或添加图片');
                contentInput.focus();
                return;
            }
            setTip('');
            send.disabled = true;
            send.textContent = '发送中…';
            postMessage(name, content, parentId, picker.file).then(function () {
                rememberName(name);
                onSuccess();
            }).catch(function (err) {
                send.disabled = false;
                send.textContent = '发送回复';
                setTip(err.message || '发送失败');
            });
        });

        return form;
    }

    /** 单条留言节点；点击内容或「回复」按钮展开回复表单 */
    function buildMessage(m, isReply, reload) {
        var wrap = el('div', isReply ? 'gb-reply' : 'gb-msg');

        var head = el('div', 'gb-msg-head');
        head.appendChild(el('span', 'gb-name', m.name));
        head.appendChild(el('span', 'gb-time', fmtTime(m.createdAt)));
        wrap.appendChild(head);

        var body = null;
        if (m.content) {
            body = el('div', 'gb-body', m.content);
            wrap.appendChild(body);
        }

        if (m.image) {
            var imgLink = document.createElement('a');
            imgLink.className = 'gb-img-link';
            imgLink.href = m.image;
            imgLink.target = '_blank';
            imgLink.rel = 'noopener noreferrer';
            var img = document.createElement('img');
            img.className = 'gb-img';
            img.src = m.image;
            img.alt = '留言图片';
            img.loading = 'lazy';
            imgLink.appendChild(img);
            wrap.appendChild(imgLink);
        }

        if (isReply) return wrap;

        if (m.replies && m.replies.length) {
            var replies = el('div', 'gb-replies');
            m.replies.forEach(function (r) {
                replies.appendChild(buildMessage(r, true, reload));
            });
            wrap.appendChild(replies);
        }

        var actions = el('div', 'gb-actions');
        var replyBtn = el('button', 'gb-reply-btn', '回复');
        replyBtn.type = 'button';
        actions.appendChild(replyBtn);
        wrap.appendChild(actions);

        var form = null;
        function toggleReply() {
            if (form) {
                form.remove();
                form = null;
                return;
            }
            form = makeReplyForm(m.id, reload, function () {
                if (form) { form.remove(); form = null; }
            });
            wrap.appendChild(form);
            var input = form.querySelector('.gb-input');
            if (input && !input.value) input.focus();
        }
        if (body) {
            body.title = '点击回复这条留言';
            body.addEventListener('click', toggleReply);
        }
        replyBtn.addEventListener('click', toggleReply);

        return wrap;
    }

    /** 页面底部「最新留言」挂件 */
    function initWidget() {
        var section = el('section', 'gb-widget');

        var head = el('div', 'gb-w-head');
        head.appendChild(el('h2', null, '最新留言'));
        var more = el('a', null, '全部留言 / 写留言 →');
        more.href = 'guestbook.html';
        head.appendChild(more);
        section.appendChild(head);

        var card = el('div', 'gb-w-list');
        section.appendChild(card);

        var footer = document.querySelector('.site-footer');
        if (footer && footer.parentNode) footer.parentNode.insertBefore(section, footer);
        else document.body.appendChild(section);

        function load() {
            card.innerHTML = '';
            card.appendChild(el('div', 'gb-state', '加载中…'));
            fetchMessages(10).then(function (data) {
                card.innerHTML = '';
                if (!data.messages.length) {
                    var empty = el('div', 'gb-state');
                    empty.appendChild(document.createTextNode('还没有留言，去'));
                    var link = el('a', null, '写第一条');
                    link.href = 'guestbook.html';
                    empty.appendChild(link);
                    empty.appendChild(document.createTextNode('吧。'));
                    card.appendChild(empty);
                    return;
                }
                data.messages.forEach(function (m) {
                    card.appendChild(buildMessage(m, false, load));
                });
            }).catch(function (err) {
                card.innerHTML = '';
                card.appendChild(el('div', 'gb-state error', err.message || '留言加载失败'));
            });
        }

        load();
    }

    /** 留言板页面 */
    function initPage() {
        var form = document.getElementById('gbForm');
        var listEl = pageEl.querySelector('.gb-list');
        var countEl = pageEl.querySelector('.gb-count');
        var nameInput = document.getElementById('gbName');
        var contentInput = document.getElementById('gbContent');
        var tipEl = pageEl.querySelector('.gb-form-tip');
        var submitBtn = form ? form.querySelector('.gb-submit') : null;

        function setTip(text) {
            if (!tipEl) return;
            tipEl.textContent = text || '';
            tipEl.className = 'gb-form-tip' + (text ? ' error' : '');
        }

        var picker = null;
        var pickerSlot = document.getElementById('gbImagePicker');
        if (pickerSlot) {
            picker = createImagePicker(setTip);
            pickerSlot.appendChild(picker.element);
        }

        if (nameInput) nameInput.value = savedName();

        function load() {
            if (!listEl) return;
            listEl.innerHTML = '';
            listEl.appendChild(el('div', 'gb-state', '加载中…'));
            fetchMessages(0).then(function (data) {
                listEl.innerHTML = '';
                if (countEl) countEl.textContent = '共 ' + data.total + ' 条';
                if (!data.messages.length) {
                    listEl.appendChild(el('div', 'gb-state', '还没有留言，快来写第一条吧。'));
                    return;
                }
                data.messages.forEach(function (m) {
                    listEl.appendChild(buildMessage(m, false, load));
                });
            }).catch(function (err) {
                listEl.innerHTML = '';
                listEl.appendChild(el('div', 'gb-state error', err.message || '留言加载失败'));
            });
        }

        if (form) {
            form.addEventListener('submit', function (e) {
                e.preventDefault();
                var name = nameInput.value.trim();
                var content = contentInput.value.trim();
                if (!name) { setTip('请填写用户名'); nameInput.focus(); return; }
                if (picker && picker.busy) { setTip('图片处理中，请稍候'); return; }
                if (!content && !(picker && picker.file)) {
                    setTip('请填写留言内容或添加图片');
                    contentInput.focus();
                    return;
                }
                setTip('');
                submitBtn.disabled = true;
                submitBtn.textContent = '提交中…';
                postMessage(name, content, null, picker ? picker.file : null).then(function () {
                    rememberName(name);
                    contentInput.value = '';
                    if (picker) picker.reset();
                    submitBtn.disabled = false;
                    submitBtn.textContent = '发表留言';
                    load();
                }).catch(function (err) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '发表留言';
                    setTip(err.message || '提交失败');
                });
            });
        }

        load();
    }

    if (pageEl) initPage();
    else initWidget();
})();
