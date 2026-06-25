/* CVApplyr article comments — first-party, dependency-free, XSS-safe (textContent only). */
(function () {
  'use strict';
  var API = '/api/article-comments';

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'html') n.innerHTML = props[k];      // ONLY used with our own trusted strings
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '?';
  }
  function timeAgo(iso) {
    var d = new Date(iso), s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (isNaN(s)) return '';
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var dd = Math.floor(h / 24); if (dd < 30) return dd + (dd === 1 ? ' day ago' : ' days ago');
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function commentNode(c, onReply) {
    var av = el('div', { class: 'cmt-av', text: initials(c.name) });
    var head = el('div', { class: 'cmt-head' }, [
      el('span', { class: 'cmt-name', text: c.name }),
      el('span', { class: 'cmt-time', text: timeAgo(c.created_at) }),
    ]);
    var body = el('div', { class: 'cmt-body' });
    body.textContent = c.body;                                   // XSS-safe
    var actions = el('div', { class: 'cmt-actions' });
    if (onReply) actions.appendChild(el('button', { class: 'cmt-reply-btn', type: 'button', text: 'Reply', onclick: function () { onReply(c); } }));
    var main = el('div', { class: 'cmt-main' }, [head, body, actions]);
    var wrap = el('div', { class: 'cmt', 'data-id': c.id }, [av, main]);
    return wrap;
  }

  function build(section) {
    var slug = section.getAttribute('data-slug') || (location.pathname.split('/').filter(Boolean).pop() || '');
    section.innerHTML = '';

    var title = el('h2', { class: 'cmt-title', text: 'Join the conversation' });
    var count = el('span', { class: 'cmt-count', text: '' });
    title.appendChild(count);
    section.appendChild(title);
    section.appendChild(el('p', { class: 'cmt-sub', text: 'Got a question or your own experience to share? Leave a comment — we read every one.' }));

    var list = el('div', { class: 'cmt-list' });
    section.appendChild(list);

    // ---------- form ----------
    var replyingTo = null;
    var replyBadge = el('div', { class: 'cmt-replybadge', style: 'display:none' });
    var fName = el('input', { class: 'cmt-in', type: 'text', name: 'name', placeholder: 'Your name', maxlength: '80', autocomplete: 'name' });
    var fEmail = el('input', { class: 'cmt-in', type: 'email', name: 'email', placeholder: 'Your email (not published)', maxlength: '160', autocomplete: 'email' });
    var fBody = el('textarea', { class: 'cmt-in cmt-ta', name: 'body', placeholder: 'Write a comment…', maxlength: '2000', rows: '4' });
    var honey = el('input', { class: 'cmt-hp', type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    var msg = el('div', { class: 'cmt-msg', style: 'display:none' });
    var submit = el('button', { class: 'cmt-submit', type: 'submit', text: 'Post comment' });

    function clearReply() { replyingTo = null; replyBadge.style.display = 'none'; replyBadge.textContent = ''; }
    function setReply(c) {
      replyingTo = c.id; replyBadge.style.display = 'flex';
      replyBadge.textContent = 'Replying to ' + c.name + '  ';
      replyBadge.appendChild(el('button', { type: 'button', class: 'cmt-replycancel', text: '✕', onclick: clearReply }));
      fBody.focus();
    }

    var form = el('form', { class: 'cmt-form', onsubmit: function (e) {
      e.preventDefault();
      msg.style.display = 'none';
      var payload = { slug: slug, name: fName.value, email: fEmail.value, body: fBody.value, website: honey.value, parent_id: replyingTo };
      if (!payload.name.trim() || !payload.email.trim() || payload.body.trim().length < 2) {
        showMsg('Please add your name, email, and a comment.', true); return;
      }
      submit.disabled = true; submit.textContent = 'Posting…';
      fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          submit.disabled = false; submit.textContent = 'Post comment';
          if (!res.ok) { showMsg(res.j && res.j.error ? res.j.error : 'Could not post. Try again.', true); return; }
          fBody.value = '';
          if (res.j.held) { showMsg('Thanks! Your comment was received and will appear after a quick review.', false); }
          else if (res.j.comment) {
            showMsg('Posted — thanks for joining in!', false);
            insertComment(res.j.comment);
          }
          clearReply();
        })
        .catch(function () { submit.disabled = false; submit.textContent = 'Post comment'; showMsg('Network error — please try again.', true); });
    } }, [
      replyBadge,
      el('div', { class: 'cmt-row' }, [fName, fEmail]),
      fBody, honey, msg,
      el('div', { class: 'cmt-formfoot' }, [submit, el('span', { class: 'cmt-priv', text: 'Be kind. Your email is never shown or shared.' })]),
    ]);
    section.appendChild(el('div', { class: 'cmt-formwrap' }, [el('h3', { class: 'cmt-formtitle', text: 'Leave a comment' }), form]));

    function showMsg(t, isErr) { msg.textContent = t; msg.className = 'cmt-msg' + (isErr ? ' err' : ' ok'); msg.style.display = 'block'; }

    // ---------- render ----------
    var byParent = {}, tops = [], total = 0;
    function render(comments) {
      list.innerHTML = ''; byParent = {}; tops = []; total = comments.length;
      comments.forEach(function (c) {
        if (c.parent_id) { (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c); }
        else tops.push(c);
      });
      count.textContent = total ? '  (' + total + ')' : '';
      if (!total) { list.appendChild(el('p', { class: 'cmt-empty', text: 'No comments yet — be the first to share your take.' })); return; }
      tops.forEach(function (c) {
        var node = commentNode(c, setReply);
        var replies = byParent[c.id] || [];
        if (replies.length) {
          var rwrap = el('div', { class: 'cmt-replies' });
          replies.forEach(function (rc) { rwrap.appendChild(commentNode(rc, setReply)); });
          node.appendChild(rwrap);
        }
        list.appendChild(node);
      });
    }
    function insertComment(c) {
      if (c.parent_id) { location.reload(); return; } // keep threading simple for fresh replies
      if (list.querySelector('.cmt-empty')) list.innerHTML = '';
      list.insertBefore(commentNode(c, setReply), list.firstChild);
      total += 1; count.textContent = '  (' + total + ')';
    }

    fetch(API + '?slug=' + encodeURIComponent(slug))
      .then(function (r) { return r.json(); })
      .then(function (j) { render((j && j.comments) || []); })
      .catch(function () { list.appendChild(el('p', { class: 'cmt-empty', text: 'Comments are unavailable right now.' })); });
  }

  function init() {
    var section = document.getElementById('article-comments');
    if (section) build(section);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
