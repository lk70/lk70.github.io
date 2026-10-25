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

    function postMessage(name, content, parentId) {
        return fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, content: content, parentId: parentId || null })
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
                return data;
            });
        });
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
        contentInput.placeholder = '回复内容（必填）…';

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
        form.appendChild(foot);

        function setTip(text) {
            tip.textContent = text || '';
            tip.className = 'gb-tip' + (text ? ' error' : '');
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var name = nameInput.value.trim();
            var content = contentInput.value.trim();
            if (!name) { setTip('请填写用户名'); nameInput.focus(); return; }
            if (!content) { setTip('请填写回复内容'); contentInput.focus(); return; }
            setTip('');
            send.disabled = true;
            send.textContent = '发送中…';
            postMessage(name, content, parentId).then(function () {
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

        var body = el('div', 'gb-body', m.content);
        wrap.appendChild(body);

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
        body.title = '点击回复这条留言';
        body.addEventListener('click', toggleReply);
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

        if (nameInput) nameInput.value = savedName();

        function setTip(text) {
            if (!tipEl) return;
            tipEl.textContent = text || '';
            tipEl.className = 'gb-form-tip' + (text ? ' error' : '');
        }

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
                if (!content) { setTip('请填写留言内容'); contentInput.focus(); return; }
                setTip('');
                submitBtn.disabled = true;
                submitBtn.textContent = '提交中…';
                postMessage(name, content, null).then(function () {
                    rememberName(name);
                    contentInput.value = '';
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
