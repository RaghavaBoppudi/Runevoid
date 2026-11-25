// Dialogs in place of the browser's alert(), confirm() and prompt(), which are drawn by the
// operating system and can't be styled.
//
//   await rvAlert('Saved.')                                  -> undefined
//   await rvConfirm('Skip 3 drafts?', { ok: 'Skip' })        -> true | false
//   await rvChoose('Send a test with which resume?', [{ value, label }], selected)  -> value | null
//
// Each is a modal <dialog> (focus stays inside, Esc cancels, the page behind is inert). The default
// button is rightmost, as on a classic Mac, and Return activates it.
(() => {
  'use strict';

  // warning sign, drawn like the icons in src/icons.js (24-unit grid, one flat fill)
  const ICON = '<svg class="i x2" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path class="f-m" d="M10.3 4.5a2 2 0 0 1 3.4 0l7.4 13a2 2 0 0 1-1.7 3H4.6a2 2 0 0 1-1.7-3z"/><path d="M12 9.5v4.5M12 17v.01"/></svg>';

  let seq = 0;

  function open({ message, ok = 'OK', cancel = null, choices = null, selected = '' }) {
    return new Promise((resolve) => {
      const id = `rv-dlg-${++seq}`;
      const dialog = document.createElement('dialog');
      dialog.className = 'dlg';
      dialog.setAttribute('aria-labelledby', `${id}-msg`);

      const form = document.createElement('form');
      form.method = 'dialog';

      const body = document.createElement('div');
      body.className = 'dlg-body';
      body.innerHTML = `<span class="dlg-icon">${ICON}</span>`;
      const text = document.createElement('div');
      text.className = 'dlg-text';
      const p = document.createElement('p');
      p.id = `${id}-msg`;
      p.textContent = message;   // text, never HTML: messages can contain server errors
      text.append(p);

      let select = null;
      if (choices) {
        const wrap = document.createElement('span');
        wrap.className = 'popup left';
        select = document.createElement('select');
        select.setAttribute('aria-labelledby', `${id}-msg`);
        for (const c of choices) select.add(new Option(c.label, c.value, false, c.value === selected));
        wrap.append(select);
        text.append(wrap);
      }
      body.append(text);

      // The default (OK) button comes first in the DOM so Return submits it; CSS shows it rightmost.
      const buttons = document.createElement('div');
      buttons.className = 'dlg-buttons';
      const okButton = document.createElement('button');
      okButton.type = 'submit';
      okButton.value = 'ok';
      okButton.className = 'primary';
      okButton.textContent = ok;
      buttons.append(okButton);
      if (cancel) {
        const cancelButton = document.createElement('button');
        cancelButton.type = 'submit';
        cancelButton.value = 'cancel';
        cancelButton.textContent = cancel;
        buttons.append(cancelButton);
      }

      form.append(body, buttons);
      dialog.append(form);
      document.body.append(dialog);

      dialog.addEventListener('close', () => {
        const accepted = dialog.returnValue === 'ok';
        const value = select ? select.value : null;
        dialog.remove();
        if (choices) resolve(accepted ? value : null);
        else if (cancel) resolve(accepted);
        else resolve(undefined);
      }, { once: true });

      dialog.showModal();
      (select || okButton).focus();
    });
  }

  window.rvAlert = (message) => open({ message: String(message ?? '') });
  window.rvConfirm = (message, { ok = 'OK', cancel = 'Cancel' } = {}) =>
    open({ message: String(message ?? ''), ok, cancel });
  window.rvChoose = (message, choices, selected = '', { ok = 'OK', cancel = 'Cancel' } = {}) =>
    open({ message: String(message ?? ''), ok, cancel, choices, selected });
})();
