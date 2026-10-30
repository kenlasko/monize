/* Monize documentation pages -- theme switch, page-list drawer, on-this-page
   highlighting, search, copy buttons and the screenshot viewer.

   Same rules as app.js, and the same scan (frontend/src/test/website-dom-safety.test.ts)
   holds this file to them: nodes are built with el() from the literal
   constructors in TAGS and placed with fill()/clear(), never from a string of
   markup. A search result's link is the `u` the build wrote into
   search-index.json, checked against DOC_URL before it becomes an href. */
(function(){
'use strict';

var $  = function(s,r){ return (r||document).querySelector(s); };
var $$ = function(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };

var TAGS = {
  a:      function(){ return document.createElement('a'); },
  button: function(){ return document.createElement('button'); },
  div:    function(){ return document.createElement('div'); },
  li:     function(){ return document.createElement('li'); },
  mark:   function(){ return document.createElement('mark'); },
  span:   function(){ return document.createElement('span'); }
};
function add(n,c){
  if(c==null||c===false) return;
  if(Array.isArray(c)){ c.forEach(function(x){ add(n,x); }); return; }
  n.appendChild(typeof c==='string' ? document.createTextNode(c) : c);
}
var el = function(t,c){
  var make = Object.prototype.hasOwnProperty.call(TAGS,t) && TAGS[t];
  if(!make) throw new Error('el: unknown tag "'+t+'" -- add it to TAGS');
  var n=make();
  if(c) n.className=c;
  for(var i=2;i<arguments.length;i++) add(n,arguments[i]);
  return n;
};
function clear(n){ while(n.firstChild) n.removeChild(n.firstChild); return n; }
function fill(n){
  clear(n);
  for(var i=1;i<arguments.length;i++) add(n,arguments[i]);
  return n;
}

var root = document.documentElement;
var body = document.body;
var hdr = $('#hdr');
var headerHeight = function(){ return hdr ? hdr.offsetHeight : 62; };

/* theme */
function paintTheme(){ var b=$('#theme'); if(b) b.textContent = root.getAttribute('data-theme')==='light' ? '☀' : '☾'; }
paintTheme();
$('#theme').addEventListener('click',function(){
  var next = root.getAttribute('data-theme')==='light' ? 'dark' : 'light';
  root.setAttribute('data-theme',next); paintTheme();
  try{ localStorage.setItem('mz-theme',next); }catch(e){}
});

/* page-list drawer (narrow screens) */
var side=$('#side'), sideBtn=$('#sideBtn'), shade=$('#shade');
function setSide(open){
  body.classList.toggle('side-open',open);
  sideBtn.setAttribute('aria-expanded',String(open));
  shade.hidden=!open;
  if(open){ var cur=$('a[aria-current=page]',side); if(cur) cur.focus(); }
}
sideBtn.addEventListener('click',function(){ setSide(!body.classList.contains('side-open')); });
shade.addEventListener('click',function(){ setSide(false); });
side.addEventListener('click',function(e){ if(e.target.closest('a')) setSide(false); });

/* The current page's link starts in view in a long page list. The list's own
   scrollTop, never scrollIntoView, which would scroll the document too. */
(function(){
  var cur=$('a[aria-current=page]',side);
  if(cur && cur.offsetTop > side.clientHeight*0.6) side.scrollTop = cur.offsetTop - side.clientHeight/3;
})();

/* on this page: highlight the section being read */
var tocLinks=$$('.dtoc a');
var heads=tocLinks.map(function(a){ return document.getElementById(decodeURIComponent(a.hash.slice(1))); });
var toc=$('.dtoc');
var ticking=false;
function spy(){
  ticking=false;
  if(hdr) hdr.classList.toggle('stuck',window.scrollY>4);
  if(!tocLinks.length) return;
  var line=headerHeight()+48, on=-1;
  for(var i=0;i<heads.length;i++){ if(heads[i] && heads[i].getBoundingClientRect().top<=line) on=i; else if(heads[i]) break; }
  if(window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-2) on=heads.length-1;
  tocLinks.forEach(function(a,i){ a.classList.toggle('on',i===on); });
  var a=tocLinks[on];
  if(a && toc.scrollHeight>toc.clientHeight){
    if(a.offsetTop<toc.scrollTop+40) toc.scrollTop=a.offsetTop-40;
    else if(a.offsetTop>toc.scrollTop+toc.clientHeight-60) toc.scrollTop=a.offsetTop-toc.clientHeight+60;
  }
}
window.addEventListener('scroll',function(){ if(!ticking){ ticking=true; requestAnimationFrame(spy); } },{passive:true});
spy();

/* copy buttons on code blocks */
$$('.doc pre').forEach(function(pre){
  var code=$('code',pre)||pre;
  var b=el('button','copy','Copy');
  b.type='button';
  b.setAttribute('aria-label','Copy code to clipboard');
  b.addEventListener('click',function(){
    if(!navigator.clipboard) return;
    navigator.clipboard.writeText(code.textContent).then(function(){
      b.textContent='Copied';
      setTimeout(function(){ b.textContent='Copy'; },1600);
    }).catch(function(){});
  });
  pre.appendChild(b);
});

/* screenshot viewer: a copy of the picture already on the page, so no URL is
   read back out of the DOM and written into a new one */
var zoomer=null, zoomFrom=null;
function closeZoom(){ if(!zoomer) return; zoomer.remove(); zoomer=null; if(zoomFrom) zoomFrom.focus(); }
$$('.doc figure img').forEach(function(img){
  img.addEventListener('click',function(){
    var copy=img.cloneNode(false);
    copy.removeAttribute('loading');
    copy.removeAttribute('width'); copy.removeAttribute('height');
    zoomFrom=document.activeElement;
    zoomer=el('div','zoomer',copy);
    zoomer.setAttribute('role','dialog');
    zoomer.setAttribute('aria-modal','true');
    zoomer.setAttribute('aria-label',img.alt||'Screenshot');
    zoomer.tabIndex=-1;
    zoomer.addEventListener('click',closeZoom);
    body.appendChild(zoomer);
    zoomer.focus();
  });
});

/* search */
var DOC_URL=/^\/docs\/[a-z0-9-]*(#[a-z0-9-]+)?$/;
var dlg=$('#search'), q=$('#q'), list=$('#sres');
var entries=null, loading=null, results=[], active=0, opener=null;

function load(){
  if(loading) return loading;
  loading=fetch('/docs/search-index.json',{credentials:'same-origin'})
    .then(function(r){ if(!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function(rows){
      entries=rows.filter(function(r){ return typeof r.u==='string' && DOC_URL.test(r.u); }).map(function(r){
        return { u:r.u, p:String(r.p), h:String(r.h||''), x:String(r.x||''),
                 pl:String(r.p).toLowerCase(), hl:String(r.h||'').toLowerCase(), xl:String(r.x||'').toLowerCase() };
      });
      run();
    })
    .catch(function(){ loading=null; message('Search could not load. Check your connection and try again.'); });
  return loading;
}

function terms(s){ return s.toLowerCase().split(/\s+/).filter(Boolean); }
function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

function score(e,ts,phrase){
  var s=0;
  for(var i=0;i<ts.length;i++){
    var t=ts[i], inH=e.hl.indexOf(t)>=0, inP=e.pl.indexOf(t)>=0, inX=e.xl.indexOf(t)>=0;
    if(!inH&&!inP&&!inX) return 0;
    s+=(inH?10:0)+(inP?4:0)+(inX?1:0);
  }
  if(ts.length>1){ if(e.hl.indexOf(phrase)>=0) s+=15; else if(e.xl.indexOf(phrase)>=0) s+=5; }
  if(e.hl===phrase||e.pl===phrase) s+=20;
  return s;
}

function snippet(e,ts){
  var x=e.x, at=-1;
  for(var i=0;i<ts.length&&at<0;i++) at=e.xl.indexOf(ts[i]);
  if(at<0) at=0;
  var from=Math.max(0,at-60), to=Math.min(x.length,at+160);
  if(from>0){ var sp=x.indexOf(' ',from); if(sp>=0&&sp<at) from=sp+1; }
  return (from>0?'…':'')+x.slice(from,to)+(to<x.length?'…':'');
}

function marked(text,ts){
  if(!ts.length) return text;
  var re=new RegExp('('+ts.map(escRe).join('|')+')','ig');
  return text.split(re).map(function(part,i){ return i%2 ? el('mark',null,part) : part; });
}

function message(text){ fill(list, el('li','snone',text)); q.removeAttribute('aria-activedescendant'); }

function run(){
  var raw=q.value.trim();
  if(!raw){ clear(list); results=[]; q.removeAttribute('aria-activedescendant'); return; }
  if(!entries){ message('Loading…'); load(); return; }
  var ts=terms(raw), phrase=ts.join(' ');
  results=entries
    .map(function(e,i){ return {e:e,s:score(e,ts,phrase),i:i}; })
    .filter(function(r){ return r.s>0; })
    .sort(function(a,b){ return b.s-a.s || a.i-b.i; })
    .slice(0,20);
  if(!results.length){ message('No results for “'+raw+'”.'); return; }
  active=0;
  fill(list, results.map(function(r,i){
    var a=el('a',null,
      el('span','sp',r.e.p),
      el('span','sh',marked(r.e.h||r.e.p,ts)),
      r.e.x ? el('span','sx',marked(snippet(r.e,ts),ts)) : null);
    a.href=r.e.u;
    a.id='sr-'+i;
    a.setAttribute('role','option');
    a.addEventListener('click',close);
    a.addEventListener('mousemove',function(){ if(active!==i){ active=i; paint(); } });
    var li=el('li',null,a);
    li.setAttribute('role','presentation');
    return li;
  }));
  paint();
}

function paint(){
  var links=$$('a',list);
  links.forEach(function(a,i){ a.setAttribute('aria-selected',String(i===active)); });
  var a=links[active];
  if(!a) return;
  q.setAttribute('aria-activedescendant',a.id);
  if(a.offsetTop<list.scrollTop) list.scrollTop=a.offsetTop-6;
  else if(a.offsetTop+a.offsetHeight>list.scrollTop+list.clientHeight) list.scrollTop=a.offsetTop+a.offsetHeight-list.clientHeight+6;
}

function open(){
  if(!dlg.hidden) return;
  opener=document.activeElement;
  setSide(false);
  dlg.hidden=false;
  body.style.overflow='hidden';
  q.focus(); q.select();
  load();
}
function close(){
  if(dlg.hidden) return;
  dlg.hidden=true;
  body.style.overflow='';
  if(opener&&opener.focus) opener.focus();
}

$$('[data-search-open]').forEach(function(b){ b.addEventListener('click',open); });
dlg.addEventListener('click',function(e){ if(e.target===dlg) close(); });
q.addEventListener('input',run);
q.addEventListener('keydown',function(e){
  if(e.key==='ArrowDown'&&results.length){ e.preventDefault(); active=(active+1)%results.length; paint(); }
  else if(e.key==='ArrowUp'&&results.length){ e.preventDefault(); active=(active-1+results.length)%results.length; paint(); }
  else if(e.key==='Enter'){ var a=$$('a',list)[active]; if(a){ e.preventDefault(); a.click(); } }
});

document.addEventListener('keydown',function(e){
  var typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)||document.activeElement.isContentEditable;
  if(e.key==='Escape'){ if(zoomer) closeZoom(); else if(!dlg.hidden) close(); else if(body.classList.contains('side-open')){ setSide(false); sideBtn.focus(); } return; }
  if((e.key==='k'||e.key==='K')&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); open(); return; }
  if(e.key==='/'&&!typing&&!e.ctrlKey&&!e.metaKey&&!e.altKey){ e.preventDefault(); open(); }
});

})();
