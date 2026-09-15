/* Thin wrapper over the Apps Script web app. */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'cbcb-hotdesk-token';

  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  /**
   * Apps Script cannot set CORS headers, so the request has to stay "simple":
   * text/plain content type, no custom headers, no preflight.
   */
  function call(action, params) {
    var url = global.HOTDESK_CONFIG.apiUrl;
    if (!url || url.indexOf('PASTE_') === 0) {
      return Promise.reject(new Error('The API URL has not been configured in js/config.js yet.'));
    }
    var body = Object.assign({ action: action, token: token() }, params || {});
    // Without a deadline a hung server leaves the board's busy flag set and
    // every button dead, with nothing on screen to explain why.
    var abort = new AbortController();
    var timer = setTimeout(function () { abort.abort(); }, 15000);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      signal: abort.signal,
      body: JSON.stringify(body),
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('The server did not respond. Check your VPN connection and try again.');
      }
      throw new Error('Could not reach the server. Check your VPN connection.');
    }).then(function (res) {
      if (!res.ok) throw new Error('Server returned ' + res.status + '.');
      return res.text();
    }).then(function (text) {
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        // Usually a proxy or captive portal returning an HTML page instead of
        // the API's JSON.
        throw new Error('The server sent something unexpected. If you are off the ' +
                        'UMIACS VPN, connect and try again.');
      }
      if (!parsed.ok) throw new Error(parsed.error || 'Request failed.');
      return parsed.data;
    }).finally(function () { clearTimeout(timer); });
  }

  global.API = {
    token: token,
    setToken: setToken,
    call: call,
    login: function (code) {
      return call('login', { code: code }).then(function (data) {
        setToken(data.token);
        return data.user;
      });
    },
    signOut: function () { setToken(''); },
  };
})(window);
