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
    buildTable(el, columns, rows);
  }

  function buildTable(el, columns, rows) {
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
      { head: '', cell: function (r) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = r.active ? 'btn btn-danger btn-sm' : 'btn btn-sm';
          b.textContent = r.active ? 'Deactivate' : 'Reactivate';
          b.addEventListener('click', function () {
            if (r.active && !confirm(
                'Deactivate ' + (r.name || r.email) + '?\n\n' +
                'They will not be able to sign in, and any desks they are holding ' +
                'from today onward are released. Their history is kept.')) return;
            API.call('adminSetActive', { email: r.email, active: !r.active })
              .then(function (res) {
                Hotdesk.toast(res.active
                  ? (r.name || r.email) + ' can sign in again.'
                  : (r.name || r.email) + ' deactivated' +
                    (res.released ? ', ' + res.released + ' desk(s) released.' : '.'));
                return open();
              })
              .catch(function (err) { Hotdesk.toast(err.message, true); });
          });
          return b;
        } },
    ], admin.roster);
    // Grey out the people who are switched off, so the roster reads at a glance.
    var rows = document.querySelectorAll('#roster-table tbody tr');
    admin.roster.forEach(function (r, i) {
      if (!r.active && rows[i]) rows[i].classList.add('is-inactive');
    });
  }

  /* ------------------------- roster import ---------------------------- */

  var importedCsv = '';

  function csvText() {
    return (document.getElementById('roster-csv').value || '').trim();
  }

  function runImport(dryRun) {
    var csv = csvText();
    if (!csv) { Hotdesk.toast('Choose a file or paste some rows first.', true); return; }
    API.call('adminImportRoster', { csv: csv, dryRun: dryRun })
      .then(function (res) {
        renderImport(res);
        if (!dryRun) {
          importedCsv = '';
          $('#roster-apply').hidden = true;
          return open().then(function () { renderImport(res); });
        }
        importedCsv = csv;
        $('#roster-apply').hidden = res.added + res.updated === 0;
        $('#roster-clear').hidden = false;
      })
      .catch(function (err) { Hotdesk.toast(err.message, true); });
  }

  function renderImport(res) {
    var host = $('#roster-import-result');
    host.textContent = '';

    var summary = document.createElement('p');
    summary.className = 'import-summary';
    summary.textContent = res.dryRun
      ? 'Preview: ' + res.added + ' to add, ' + res.updated + ' to update, ' +
        res.skipped + ' skipped. Nothing saved yet.'
      : 'Done: ' + res.added + ' added, ' + res.updated + ' updated, ' +
        res.skipped + ' skipped.';
    host.appendChild(summary);

    var wrap = document.createElement('div');
    wrap.className = 'scroll-x';
    host.appendChild(wrap);

    var columns = [
      { head: 'Line', cell: function (r) { return String(r.line); } },
      { head: '', cell: function (r) {
          var t = document.createElement('span');
          t.className = 'tag tag-' + r.action;
          t.textContent = r.action;
          return t;
        } },
      { head: 'Email', cell: function (r) { return r.email || '—'; } },
      { head: 'Name', cell: function (r) { return r.name || '—'; } },
      { head: 'Role', cell: function (r) { return r.role || '—'; } },
      // Codes are what you hand out, so they are only worth showing once saved.
      { head: res.dryRun ? 'Code' : 'Code to send', cell: function (r) {
          return r.action === 'skip' ? '—' : (r.code || '—');
        } },
      { head: 'Note', cell: function (r) {
          return r.reason || (r.wasInactive ? 'was deactivated — switched back on' : '');
        } },
    ];
    buildTable(wrap, columns, res.rows);

    if (!res.dryRun && res.added) {
      var hint = document.createElement('p');
      hint.className = 'muted xsmall';
      hint.textContent = 'Send each new person their code. They sign in with it at ' +
                         location.origin + location.pathname;
      host.appendChild(hint);
    }
  }

  function clearImport() {
    document.getElementById('roster-csv').value = '';
    document.getElementById('roster-file').value = '';
    $('#roster-import-result').textContent = '';
    $('#roster-apply').hidden = true;
    $('#roster-clear').hidden = true;
    importedCsv = '';
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

    $('#roster-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        document.getElementById('roster-csv').value = String(reader.result || '');
        runImport(true);          // preview immediately; applying stays deliberate
      };
      reader.onerror = function () { Hotdesk.toast('Could not read that file.', true); };
      reader.readAsText(file);
    });
    $('#roster-preview').addEventListener('click', function () { runImport(true); });
    $('#roster-apply').addEventListener('click', function () {
      if (csvText() !== importedCsv) {
        Hotdesk.toast('The rows changed since the preview — preview again first.', true);
        return;
      }
      runImport(false);
    });
    $('#roster-clear').addEventListener('click', clearImport);
  });
})(window);
