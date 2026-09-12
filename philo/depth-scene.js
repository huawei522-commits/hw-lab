/* 讓橫幅那張版畫「有深度」：依深度圖即時位移，滑鼠移動就看得出前後層次。
   WebGL 跑不起來時什麼都不做，原本的靜態圖照常顯示。 */
(function () {
  'use strict';

  var VERT =
    'attribute vec2 aPos;varying vec2 vUv;' +
    'void main(){vUv=aPos*0.5+0.5;vUv.y=1.0-vUv.y;gl_Position=vec4(aPos,0.0,1.0);}';

  var FRAG =
    'precision mediump float;' +
    'uniform sampler2D uImg;uniform sampler2D uDepth;' +
    'uniform vec2 uOff;uniform float uZoom;' +
    'varying vec2 vUv;' +
    'void main(){' +
    '  vec2 base=(vUv-0.5)/uZoom+0.5;' +
    /* 反覆逼近：用位移後取到的深度再修正一次，邊界比較不會糊 */
    '  vec2 uv=base;' +
    '  for(int i=0;i<4;i++){' +
    '    float d=texture2D(uDepth,uv).r;' +
    '    uv=base+uOff*(d-0.42);' +
    '  }' +
    '  gl_FragColor=texture2D(uImg,clamp(uv,0.001,0.999));' +
    '}';

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
    return s;
  }

  function texture(gl, img) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  function load(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = rej;
      im.src = src;
    });
  }

  function init(holder, imgEl, depthSrc) {
    var gl, canvas = document.createElement('canvas');
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false })
        || canvas.getContext('experimental-webgl');
    } catch (e) { return; }
    if (!gl) return;

    canvas.className = 'depth-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    holder.appendChild(canvas);

    Promise.all([load(imgEl.currentSrc || imgEl.src), load(depthSrc)]).then(function (r) {
      var img = r[0], dep = r[1];

      var p = gl.createProgram();
      var vs = compile(gl, gl.VERTEX_SHADER, VERT), fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      if (!vs || !fs) return;
      gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return;
      gl.useProgram(p);

      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0); texture(gl, img);
      gl.uniform1i(gl.getUniformLocation(p, 'uImg'), 0);
      gl.activeTexture(gl.TEXTURE1); texture(gl, dep);
      gl.uniform1i(gl.getUniformLocation(p, 'uDepth'), 1);

      var uOff = gl.getUniformLocation(p, 'uOff');
      var uZoom = gl.getUniformLocation(p, 'uZoom');
      gl.uniform1f(uZoom, 1.06);          // 稍微推進去，位移時邊緣才不會露出空白

      imgEl.style.visibility = 'hidden';   // 圖還留著當後備，只是不顯示
      var hint = document.createElement('span');
      hint.className = 'depth-hint';
      hint.textContent = '移動滑鼠';
      holder.appendChild(hint);
      holder.classList.add('depth-on');

      function resize() {
        var r = holder.getBoundingClientRect();
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var w = Math.max(1, Math.round(r.width * dpr));
        var h = Math.max(1, Math.round(r.width * dpr * img.height / img.width));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w; canvas.height = h;
          gl.viewport(0, 0, w, h);
        }
      }
      resize();
      window.addEventListener('resize', resize);

      var STRENGTH = 0.040;               // 位移幅度：再大就會開始看到破綻
      var tx = 0, ty = 0, cx = 0, cy = 0, lastMove = -1e9, hovering = false;

      holder.addEventListener('pointermove', function (e) {
        var r = holder.getBoundingClientRect();
        tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
        ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
        lastMove = performance.now();
        hovering = true;
      });
      holder.addEventListener('pointerleave', function () { hovering = false; });

      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // 捲出畫面就停下來，不要在背景一直空轉
      var visible = true, running = false;
      if (window.IntersectionObserver) {
        new IntersectionObserver(function (es) {
          visible = es[0].isIntersecting;
          if (visible && !running) { running = true; requestAnimationFrame(frame); }
        }, { threshold: 0.01 }).observe(holder);
      }

      function frame(t) {
        if (!visible) { running = false; return; }
        if (!hovering) {                  // 沒人碰的時候，讓它自己非常緩慢地飄
          var s = reduce ? 0 : 1;
          tx = Math.sin(t / 4200) * 0.45 * s;
          ty = Math.sin(t / 6100) * 0.28 * s;
        }
        cx += (tx - cx) * 0.055;
        cy += (ty - cy) * 0.055;
        gl.uniform2f(uOff, -cx * STRENGTH, -cy * STRENGTH * 0.55);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        requestAnimationFrame(frame);
      }
      running = true;
      requestAnimationFrame(frame);
    }).catch(function () { /* 載入失敗就維持原本的靜態圖 */ });
  }

  function start() {
    var holder = document.querySelector('.scene-banner');
    if (!holder) return;
    var imgEl = holder.querySelector('img');
    if (!imgEl) return;
    if (imgEl.complete && imgEl.naturalWidth) init(holder, imgEl, 'img/scene_dialogue_depth.webp');
    else imgEl.addEventListener('load', function () { init(holder, imgEl, 'img/scene_dialogue_depth.webp'); }, { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
