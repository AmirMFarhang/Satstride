// Applies the stored theme before first paint (classic script, loaded in <head>).
;(function () {
  try {
    var t = localStorage.getItem('passbook-console-theme')
    document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light')
  } catch (e) { document.documentElement.setAttribute('data-theme', 'light') }
})()
