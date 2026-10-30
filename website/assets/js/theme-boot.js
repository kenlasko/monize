/* Documentation pages: apply the saved or preferred colour theme before the
   first paint. Loaded as a blocking script in <head>; docs.js owns the toggle. */
(function(){try{var t=localStorage.getItem('mz-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
