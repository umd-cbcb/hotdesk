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
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) throw new Error('Server returned ' + res.status + '.');
      return res.text();
    }).then(function (text) {
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        // Almost always the deployment's access setting, which serves an HTML
        // sign-in page instead of JSON.
        throw new Error('Unexpected response from the server. Check that the web app is deployed with access set to "Anyone".');
      }
      if (!parsed.ok) throw new Error(parsed.error || 'Request failed.');
      return parsed.data;
    });
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
