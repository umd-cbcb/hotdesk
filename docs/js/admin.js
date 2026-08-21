/* CBCB Hotdesk — moderator tools. */
(function (global) {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var admin = null;

  var CONFIG_FIELDS = [
    ['siteTitle', 'Site title', 'text'],
    ['releaseTime', 'Booking opens at (HH:MM)', 'text'],
    ['horizonDays', 'Days bookable ahead', 'number'],
    ['maxOpenClaims', 'Max upcoming days per person', 'number'],
    ['checkInDeadline', 'Check-in deadline (HH:MM)', 'text'],
    ['checkInEnabled', 'Require check-in (TRUE/FALSE)', 'text'],
    ['allowSameDayClaim', 'Allow walk-up claims (TRUE/FALSE)', 'text'],
    ['timezone', 'Timezone', 'text'],
    ['noticeText', 'Banner notice (blank to hide)', 'text'],
  ];

  function open() {
    return API.call('adminState', {}).then(function (data) {
      admin = data;
      Hotdesk.show('view-admin');
      renderConfig();
      renderRoster();
      renderDesks();
      renderUpcoming();
    }).catch(function (err) { Hotdesk.toast(err.message, true); });
  }

  function renderConfig() {
    var form = $('#cfg-form');
    form.textContent = '';
    CONFIG_FIELDS.forEach(function (f) {
      var key = f[0], label = f[1], type = f[2];
      var row = document.createElement('div');
      row.className = 'cfg-row';
      var lab = document.createElement('label');
      lab.textContent = label;
      lab.setAttribute('for', 'cfg-' + key);
      var input = document.createElement('input');
      input.id = 'cfg-' + key;
      input.type = type;
      input.name = key;
      input.value = admin.config[key] === undefined ? '' : String(admin.config[key]);
      row.appendChild(lab);
      row.appendChild(input);
      form.appendChild(row);
    });
  }

  function saveConfig() {
    var updates = {};
    CONFIG_FIELDS.forEach(function (f) {
      updates[f[0]] = $('#cfg-' + f[0]).value;
    });
    API.call('adminSetConfig', { updates: updates }).then(function () {
      Hotdesk.toast('Settings saved.');
    }).catch(function (err) { Hotdesk.toast(err.message, true); });
  }

  function table(container, columns, rows) {
    var el = document.querySelector(container);
    el.textContent = '';
    var t = document.createElement('table');
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    columns.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c.head;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    t.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      columns.forEach(function (c) {
        var td = document.createElement('td');
        var value = c.cell(row);
        if (value instanceof Node) td.appendChild(value); else td.textContent = value;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    el.appendChild(t);
  }

  function renderRoster() {
    table('#roster-table', [
      { head: 'Name', cell: function (r) { return r.name; } },
      { head: 'Email', cell: function (r) { return r.email; } },
      { head: 'Code', cell: function (r) { return r.code; } },
      { head: 'Role', cell: function (r) { return r.role; } },
      { head: 'Lab', cell: function (r) { return r.lab; } },
      { head: 'Showed up', cell: function (r) {
          var total = r.honoured + r.missed;
          return total ? r.honoured + '/' + total : '—';
        } },
      { head: 'Active', cell: function (r) { return r.active ? 'yes' : 'no'; } },
    ], admin.roster);
  }

  function renderDesks() {
    table('#desk-table', [
      { head: 'ID', cell: function (d) { return d.deskId; } },
      { head: 'Label', cell: function (d) { return d.label; } },
      { head: 'Room', cell: function (d) { return d.room; } },
      { head: 'On map', cell: function (d) {
          return (typeof d.x === 'number' && typeof d.y === 'number') ? 'yes' : 'no';
        } },
      { head: 'Status', cell: function (d) { return d.status; } },
      { head: 'Reserved for', cell: function (d) { return d.reservedFor || '—'; } },
    ], admin.desks);
  }

  function renderUpcoming() {
    var byEmail = {};
    admin.roster.forEach(function (r) { byEmail[r.email] = r.name; });
    var rows = admin.upcoming.slice().sort(function (a, b) {
      return a.date.localeCompare(b.date) || a.deskId.localeCompare(b.deskId);
    });
    table('#upcoming-table', [
      { head: 'Date', cell: function (c) { return c.date; } },
      { head: 'Desk', cell: function (c) { return c.deskId; } },
      { head: 'Who', cell: function (c) { return byEmail[c.email] || c.email; } },
      { head: 'Checked in', cell: function (c) { return c.checkedInAt ? 'yes' : 'no'; } },
      { head: '', cell: function (c) {
          var b = document.createElement('button');
          b.className = 'btn btn-ghost';
          b.textContent = 'Force release';
          b.addEventListener('click', function () {
            if (!confirm('Release ' + c.deskId + ' on ' + c.date + '?')) return;
            API.call('adminForceRelease', { claimId: c.claimId })
              .then(open)
              .then(function () { Hotdesk.toast('Released.'); })
              .catch(function (err) { Hotdesk.toast(err.message, true); });
          });
          return b;
        } },
    ], rows);
  }

  function savePerson(e) {
    e.preventDefault();
    var form = e.target;
    var person = {
      email: form.email.value, name: form.name.value,
      lab: form.lab.value, role: form.role.value,
    };
    API.call('adminSavePerson', { person: person }).then(function (res) {
      var out = $('#person-result');
      out.textContent = 'Saved. ' + res.saved + ' — access code: ' + res.code;
      out.hidden = false;
      form.reset();
      return open();
    }).catch(function (err) { Hotdesk.toast(err.message, true); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#btn-admin').addEventListener('click', open);
    $('#btn-back').addEventListener('click', function () {
      Hotdesk.show('view-board');
      Hotdesk.load().catch(function () {});
    });
    $('#cfg-save').addEventListener('click', saveConfig);
    $('#person-form').addEventListener('submit', savePerson);
  });
})(window);
