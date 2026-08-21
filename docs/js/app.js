/* CBCB Hotdesk — board view. */
(function (global) {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var state = { data: null, selectedDate: null, view: 'map', busy: false, planLoaded: false };

  var STATES = [
    { key: 'free',  label: 'Free' },
    { key: 'mine',  label: 'Yours' },
    { key: 'taken', label: 'In use' },
    { key: 'hold',  label: 'Claimed, not arrived' },
    { key: 'off',   label: 'Unavailable' },
  ];

  /* ------------------------------ helpers ------------------------------- */

  function show(id) {
    ['view-login', 'view-board', 'view-admin'].forEach(function (v) {
      $('#' + v).hidden = (v !== id);
    });
    $('#boot').hidden = true;
  }

  function toast(message, isError) {
    var el = $('#toast');
    el.textContent = message;
    el.classList.toggle('is-error', !!isError);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, isError ? 5200 : 2800);
  }

  function parseYmd(ymd) {
    var p = ymd.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function dayLabel(ymd, todayYmd) {
    var diff = Math.round((parseYmd(ymd) - parseYmd(todayYmd)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return parseYmd(ymd).toLocaleDateString(undefined, { weekday: 'short' });
  }

  function dateSub(ymd) {
    return parseYmd(ymd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // The server normalises times to HH:mm, but never render a raw Date string at
  // the user if something slips through — pull the clock out of it instead.
  function prettyTime(value) {
    var text = String(value === undefined || value === null ? '' : value).trim();
    var m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text) ||
            /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/.exec(text);
    if (!m) return text;
    var h = Number(m[1]), suffix = h >= 12 ? 'pm' : 'am';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (m[2] === '00' ? '' : ':' + m[2]) + suffix;
  }

  function initials(name) {
    // Drop anything that is not a letter or digit first, so a parenthesised or
    // punctuated name does not put a bracket in the avatar.
    var parts = String(name || '').split(/\s+/)
      .map(function (w) { return w.replace(/[^\p{L}\p{N}]/gu, ''); })
      .filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, cls, onClick) {
    var b = el('button', 'btn ' + cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function currentDay() {
    return (state.data.days || []).filter(function (d) {
      return d.date === state.selectedDate;
    })[0];
  }

  function deskById(id) {
    return state.data.desks.filter(function (d) { return d.deskId === id; })[0];
  }

  /* ------------------------------ loading ------------------------------- */

  function load() {
    return API.call('state', {}).then(function (data) {
      state.data = data;
      if (!state.selectedDate ||
          !data.days.some(function (d) { return d.date === state.selectedDate; })) {
        state.selectedDate = data.now.date;
      }
      render();
      return data;
    });
  }

  /**
   * An <img> cannot inherit the page's CSS variables, so an SVG plan is injected
   * inline instead and follows the theme. A raster plan (a photo or a scan of
   * the real floor plan) cannot follow anything, so it keeps a white sheet under
   * it in both themes — the same compromise maps make.
   */
  function loadPlan() {
    if (state.planLoaded) return;
    state.planLoaded = true;
    var src = (global.HOTDESK_CONFIG && global.HOTDESK_CONFIG.floorplan) || '';
    var host = $('#plan-host');
    var missing = $('#map-missing');

    if (!src) { planFailed('No floor plan configured.'); return; }

    if (/\.svg(\?|$)/i.test(src)) {
      fetch(src).then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      }).then(function (svg) {
        host.innerHTML = svg;
        var node = host.querySelector('svg');
        if (node) { node.removeAttribute('width'); node.removeAttribute('height'); }
        missing.hidden = true;
      }).catch(function () {
        planFailed('Could not load the floor plan image.');
      });
      return;
    }

    var img = new Image();
    img.alt = 'Floor plan';
    img.addEventListener('load', function () {
      host.appendChild(img);
      $('#map-wrap').classList.add('is-raster');
      missing.hidden = true;
    });
    img.addEventListener('error', function () {
      planFailed('Could not load the floor plan image.');
    });
    img.src = src;
  }

  function planFailed(message) {
    var missing = $('#map-missing');
    missing.textContent = message + ' Use the list view, or add one with the desk mapper.';
    missing.hidden = false;
  }

  /* ------------------------------ rendering ----------------------------- */

  function render() {
    var d = state.data;
    show('view-board');

    $('#site-title').textContent = d.config.siteTitle || 'CBCB Hotdesk';
    document.title = d.config.siteTitle || 'CBCB Hotdesk';
    $('#whoami').textContent = d.user.name;
    $('#btn-admin').hidden = d.user.role !== 'moderator';
    $('#clock').textContent = dateSub(d.now.date);

    // Moderators see configuration problems; students should not have to care.
    var warnings = d.config.warnings || [];
    var notice = $('#notice');
    var lines = warnings.slice();
    if (d.config.noticeText) lines.unshift(d.config.noticeText);
    notice.textContent = '';
    lines.forEach(function (line, i) {
      if (i) notice.appendChild(document.createElement('br'));
      notice.appendChild(document.createTextNode(
        (warnings.indexOf(line) > -1 ? 'Check the Config tab: ' : '') + line));
    });
    notice.hidden = !lines.length;

    renderPresence();
    renderDayStrip();
    renderMyStatus();
    renderBanner();
    renderLegend();
    renderDesks();
    renderRules();
  }

  /** Who is actually in the room right now — the question people open this to ask. */
  function renderPresence() {
    var d = state.data;
    var today = d.days.filter(function (x) { return x.date === d.now.date; })[0];
    var box = $('#presence');
    var host = $('#presence-avatars');
    host.textContent = '';
    if (!today || !today.claims.length) { box.hidden = true; return; }
    box.hidden = false;

    today.claims.slice().sort(function (a, b) {
      return (b.checkedIn - a.checkedIn) || a.name.localeCompare(b.name);
    }).forEach(function (c) {
      var desk = deskById(c.deskId);
      var chip = el('span', 'avatar', initials(c.name));
      if (c.mine) chip.classList.add('is-me');
      else if (!c.checkedIn) chip.classList.add('is-pending');
      chip.title = c.name + ' — ' + (desk ? desk.label : c.deskId) +
        (c.checkedIn ? '' : ' (claimed, not arrived)');
      host.appendChild(chip);
    });

    var here = today.claims.filter(function (c) { return c.checkedIn; }).length;
    var pending = today.claims.length - here;
    $('.presence-label').textContent = pending
      ? here + ' in · ' + pending + ' expected'
      : here + ' in today';
  }

  function renderDayStrip() {
    var d = state.data;
    var strip = $('#daystrip');
    strip.textContent = '';
    d.days.forEach(function (day) {
      var free = countFree(day);
      var total = activeDeskCount();
      var btn = el('button', 'day' +
        (day.date === state.selectedDate ? ' is-on' : '') +
        (day.window.claimable ? '' : ' is-locked'));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(day.date === state.selectedDate));
      btn.appendChild(el('span', 'day-name', dayLabel(day.date, d.now.date)));
      btn.appendChild(el('span', 'day-sub', day.window.claimable
        ? dateSub(day.date) + ' · ' + free + ' free'
        : dateSub(day.date) + ' · locked'));
      var meter = el('span', 'day-meter');
      var fill = document.createElement('i');
      fill.style.width = total ? Math.round(((total - free) / total) * 100) + '%' : '0%';
      fill.style.background = day.window.claimable ? 'var(--taken-bd)' : 'var(--line)';
      meter.appendChild(fill);
      btn.appendChild(meter);
      btn.addEventListener('click', function () {
        state.selectedDate = day.date;
        render();
      });
      strip.appendChild(btn);
    });
  }

  function activeDeskCount() {
    return state.data.desks.filter(function (d) { return d.status === 'active'; }).length;
  }

  function countFree(day) {
    var taken = {};
    day.claims.forEach(function (c) { taken[c.deskId] = true; });
    return state.data.desks.filter(function (desk) {
      return desk.status === 'active' && !desk.reservedFor && !taken[desk.deskId];
    }).length;
  }

  function renderMyStatus() {
    var d = state.data, box = $('#my-status');
    box.textContent = '';

    var today = d.days.filter(function (x) { return x.date === d.now.date; })[0];
    var mineToday = today && today.claims.filter(function (c) { return c.mine; })[0];
    var mineUpcoming = [];
    d.days.forEach(function (day) {
      if (day.date === d.now.date) return;
      day.claims.forEach(function (c) { if (c.mine) mineUpcoming.push({ day: day, claim: c }); });
    });

    if (!mineToday && !mineUpcoming.length) { box.hidden = true; return; }
    box.hidden = false;

    if (mineToday) {
      var desk = deskById(mineToday.deskId);
      box.appendChild(el('span', null, 'Today:'));
      box.appendChild(el('span', 'mystatus-desk', desk ? desk.label : mineToday.deskId));
      if (d.config.checkInEnabled && !mineToday.checkedIn) {
        box.appendChild(el('span', 'small muted',
          'check in by ' + prettyTime(d.config.checkInDeadline) + ' or it is released'));
        box.appendChild(button('I’m here', 'btn-primary btn-sm', function () {
          act(API.call('checkin', { claimId: mineToday.claimId }), 'Checked in.');
        }));
      } else {
        box.appendChild(el('span', 'small muted', 'checked in'));
      }
      box.appendChild(el('span', 'mystatus-sep'));
      box.appendChild(button('Give it up', 'btn-danger btn-sm', function () {
        if (!confirm('Release your desk for today so someone else can use it?')) return;
        act(API.call('release', { claimId: mineToday.claimId }), 'Desk released.');
      }));
    }

    mineUpcoming.forEach(function (entry) {
      var desk = deskById(entry.claim.deskId);
      var wrap = el('span', 'small');
      wrap.textContent = dayLabel(entry.day.date, d.now.date) + ': ' +
        (desk ? desk.label : entry.claim.deskId);
      box.appendChild(wrap);
      box.appendChild(button('Cancel', 'btn-ghost btn-sm', function () {
        act(API.call('release', { claimId: entry.claim.claimId }), 'Booking cancelled.');
      }));
    });
  }

  function renderBanner() {
    var day = currentDay(), banner = $('#window-banner');
    if (!day || day.window.claimable) { banner.hidden = true; return; }
    banner.hidden = false;
    if (day.window.reason === 'not_yet') {
      banner.textContent = 'Claiming for ' + dateSub(day.date) + ' opens ' +
        (day.window.opensOn === state.data.now.date ? 'today' : 'on ' + dateSub(day.window.opensOn)) +
        ' at ' + prettyTime(day.window.opensAt) + '.';
    } else {
      banner.textContent = 'Claiming is closed for this day.';
    }
  }

  function renderLegend() {
    var host = $('#legend');
    host.textContent = '';
    STATES.forEach(function (s) {
      var item = el('span', 'legend-item');
      item.appendChild(el('span', 'legend-swatch state-' + s.key));
      item.appendChild(el('span', null, s.label));
      host.appendChild(item);
    });
  }

  function deskState(desk, day) {
    if (desk.status !== 'active') return { key: 'off', who: desk.notes || 'Out of service' };
    var claim = day.claims.filter(function (c) { return c.deskId === desk.deskId; })[0];
    if (claim) {
      if (claim.mine) return { key: 'mine', who: 'You', claim: claim };
      var pending = state.data.config.checkInEnabled &&
                    day.date === state.data.now.date && !claim.checkedIn;
      return { key: pending ? 'hold' : 'taken', who: claim.name, claim: claim };
    }
    if (desk.reservedFor && desk.reservedFor !== state.data.user.email) {
      return { key: 'off', who: 'Reserved · ' + desk.reservedForName };
    }
    return { key: 'free', who: 'Free' };
  }

  function renderDesks() {
    var day = currentDay();
    if (!day) return;

    var free = countFree(day), total = activeDeskCount();
    var avail = $('#availability');
    avail.textContent = '';
    avail.appendChild(el('b', null, String(free)));
    avail.appendChild(el('span', null, ' of ' + total + ' desks free ' +
      dayLabel(day.date, state.data.now.date).toLowerCase()));

    $('#map-wrap').hidden = state.view !== 'map';
    $('#list-wrap').hidden = state.view !== 'list';
    if (state.view === 'map') { loadPlan(); renderMap(day); } else renderList(day);
  }

  function renderMap(day) {
    var pins = $('#pins');
    var placed = state.data.desks.filter(function (d) {
      return typeof d.x === 'number' && typeof d.y === 'number';
    });
    if (!placed.length) {
      planFailed('No desks have map coordinates yet.');
    }

    pins.textContent = '';
    placed.forEach(function (desk) {
      var st = deskState(desk, day);
      var pin = el('button', 'pin state-' + st.key, desk.label);
      pin.type = 'button';
      pin.style.left = desk.x + '%';
      pin.style.top = desk.y + '%';
      pin.title = desk.label + (desk.room ? ' · ' + desk.room : '') + ' — ' + st.who;
      pin.setAttribute('aria-label', pin.title);
      if (st.key !== 'off') {
        pin.addEventListener('click', function () { onDeskClick(desk, st, day); });
      } else {
        pin.disabled = true;
      }
      pins.appendChild(pin);
    });
  }

  function renderList(day) {
    var wrap = $('#list-wrap');
    wrap.textContent = '';
    var rooms = {};
    state.data.desks.forEach(function (d) {
      var key = d.room || 'Desks';
      (rooms[key] = rooms[key] || []).push(d);
    });

    Object.keys(rooms).sort().forEach(function (room) {
      var section = el('div', 'room');
      var free = rooms[room].filter(function (d) {
        return deskState(d, day).key === 'free';
      }).length;
      section.appendChild(el('h3', null, room + ' — ' + free + ' of ' + rooms[room].length + ' free'));
      var grid = el('div', 'desk-grid');

      rooms[room].slice().sort(function (a, b) {
        return a.label.localeCompare(b.label, undefined, { numeric: true });
      }).forEach(function (desk) {
        var st = deskState(desk, day);
        var row = el('div', 'desk state-' + st.key);
        var left = el('div');
        left.appendChild(el('div', 'desk-name', desk.label));
        left.appendChild(el('div', 'desk-who',
          st.key === 'hold' ? st.who + ' · not arrived' : st.who));
        row.appendChild(left);
        var action = actionFor(desk, st, day);
        if (action) row.appendChild(action);
        grid.appendChild(row);
      });
      section.appendChild(grid);
      wrap.appendChild(section);
    });
  }

  function actionFor(desk, st, day) {
    if (st.key === 'mine') {
      return button('Release', 'btn-ghost btn-sm', function () {
        act(API.call('release', { claimId: st.claim.claimId }), 'Released.');
      });
    }
    if (st.key === 'free' && day.window.claimable) {
      return button('Claim', 'btn-primary btn-sm', function () { claim(desk, day); });
    }
    return null;
  }

  function onDeskClick(desk, st, day) {
    if (st.key === 'mine') {
      if (confirm('Release ' + desk.label + '?')) {
        act(API.call('release', { claimId: st.claim.claimId }), 'Released.');
      }
      return;
    }
    if (st.key === 'free') {
      if (!day.window.claimable) { toast('Not open for claiming yet.', true); return; }
      claim(desk, day);
      return;
    }
    toast(desk.label + ' — ' + st.who);
  }

  function claim(desk, day) {
    act(API.call('claim', { date: day.date, deskId: desk.deskId }),
        desk.label + ' is yours for ' + dayLabel(day.date, state.data.now.date).toLowerCase() + '.');
  }

  /** Run a mutating call, then always reload so the board reflects reality. */
  function act(promise, successMessage) {
    if (state.busy) return;
    state.busy = true;
    document.body.style.cursor = 'progress';
    promise.then(function () {
      toast(successMessage);
    }).catch(function (err) {
      toast(err.message, true);
    }).then(function () {
      return load().catch(function () {});
    }).then(function () {
      state.busy = false;
      document.body.style.cursor = '';
    });
  }

  function renderRules() {
    var c = state.data.config, bits = [];
    bits.push('Desks for ' + (c.horizonDays === 1 ? 'the next day' : 'up to ' + c.horizonDays + ' days ahead') +
              ' open at ' + prettyTime(c.releaseTime) + '.');
    bits.push('One desk per person per day, ' + c.maxOpenClaims + ' upcoming days at most.');
    if (c.checkInEnabled) {
      bits.push('Check in by ' + prettyTime(c.checkInDeadline) +
                ' or your desk is released to whoever needs it.');
    }
    if (c.allowSameDayClaim) bits.push('Any free desk can be taken on the spot, any time.');
    var rel = state.data.me.reliability;
    if (rel.honoured + rel.missed > 0) {
      bits.push('You have shown up for ' + rel.honoured + ' of ' +
                (rel.honoured + rel.missed) + ' desks you booked.');
    }
    $('#rules-note').textContent = bits.join(' ');
  }

  /* ------------------------------- wiring -------------------------------- */

  function wire() {
    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('#login-error');
      err.hidden = true;
      API.login($('#login-code').value).then(function () {
        return load();
      }).catch(function (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      });
    });

    $('#btn-signout').addEventListener('click', function () {
      API.signOut();
      location.reload();
    });

    document.querySelectorAll('[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.view = btn.getAttribute('data-view');
        document.querySelectorAll('[data-view]').forEach(function (b) {
          b.classList.toggle('is-on', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        renderDesks();
      });
    });

    // Someone else's claim shouldn't sit stale on a wall-mounted display.
    setInterval(function () {
      if (!state.data || state.busy || document.hidden) return;
      load().catch(function () {});
    }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.data && !state.busy) load().catch(function () {});
    });
  }

  function start() {
    wire();
    if (!API.token()) { show('view-login'); return; }
    load().catch(function (err) {
      API.signOut();
      show('view-login');
      if (err.message.indexOf('expired') < 0) {
        $('#login-error').textContent = err.message;
        $('#login-error').hidden = false;
      }
    });
  }

  global.Hotdesk = { load: load, show: show, toast: toast, state: state };
  document.addEventListener('DOMContentLoaded', start);
})(window);
