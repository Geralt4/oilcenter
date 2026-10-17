/*
 * Form-level upload coordination.
 *
 * Product photos and the SDS field are separate components sharing one form. Each used to enable
 * the submit button when ITS upload finished, so one could re-enable Save while the other was
 * still streaming. This module counts pending uploads per form, blocks submit events while any
 * upload is in flight, and only re-enables the button when the last one finishes.
 */
const pending = new WeakMap<HTMLFormElement, number>();
const guarded = new WeakSet<HTMLFormElement>();

function guard(form: HTMLFormElement): void {
  if (guarded.has(form)) return;
  guarded.add(form);
  form.addEventListener(
    'submit',
    (event) => {
      if ((pending.get(form) ?? 0) > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
}

function submitButton(form: HTMLFormElement): HTMLButtonElement | null {
  return form.querySelector<HTMLButtonElement>('button[type="submit"]');
}

export function beginUpload(form: HTMLFormElement): void {
  guard(form);
  pending.set(form, (pending.get(form) ?? 0) + 1);
  const button = submitButton(form);
  if (button) button.disabled = true;
}

export function endUpload(form: HTMLFormElement): void {
  const left = Math.max(0, (pending.get(form) ?? 1) - 1);
  pending.set(form, left);
  if (left === 0) {
    const button = submitButton(form);
    if (button) button.disabled = false;
  }
}

/** Exposed for the security test; the count is only meaningful while uploads are running. */
export function pendingUploads(form: HTMLFormElement): number {
  return pending.get(form) ?? 0;
}
