export class MaterialPanel {
  constructor(mat) {
    this._mat = mat;

    const panel = document.createElement('div');
    panel.style.cssText = `
      position:absolute; top:40px; right:12px; z-index:200;
      background:rgba(0,0,0,0.55); color:#fff; font:12px/1.6 monospace;
      padding:10px 14px; border-radius:6px; min-width:200px;
      backdrop-filter:blur(4px);
    `;

    panel.innerHTML = `<b style="font-size:13px">Body Paint</b>`;
    panel.appendChild(this._slider('Reflectivity', 'reflectivity', 0, 1, 0.01, mat.reflectivity));

    document.body.appendChild(panel);
  }

  _slider(label, prop, min, max, step, value) {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '6px';

    const valSpan = document.createElement('span');
    valSpan.textContent = value.toFixed(2);
    valSpan.style.cssText = 'float:right; min-width:32px; text-align:right';

    const input = document.createElement('input');
    input.type  = 'range';
    input.min   = min;
    input.max   = max;
    input.step  = step;
    input.value = value;
    input.style.cssText = 'width:100%; margin-top:2px; display:block';

    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      this._mat[prop] = v;
      this._mat.needsUpdate = true;
      valSpan.textContent = v.toFixed(2);
    });

    wrap.appendChild(document.createTextNode(label));
    wrap.appendChild(valSpan);
    wrap.appendChild(input);
    return wrap;
  }
}
