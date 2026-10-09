'use client';

import { startTransition, useActionState, useCallback, useEffect, useRef, type FormEvent } from 'react';

/**
 * `useActionState` for a form that must keep what was typed.
 *
 * React resets a `<form action={fn}>` to its default values as soon as the action returns — also when it returns a
 * validation error, so one mistyped e-mail used to wipe a whole message (or a whole product). Dispatching the action
 * ourselves from `onSubmit` does not trigger that reset. `action` stays on the form, so it still submits without JS.
 *
 * After a successful submit the file and password fields ARE cleared: left alone, the same photo would upload again
 * with the next save. After a failed one the first field marked invalid gets the focus.
 */
export function useKeptForm<S extends { ok: boolean } | null>(action: (prev: Awaited<S>, formData: FormData) => S | Promise<S>, initial: Awaited<S>) {
  const [state, formAction, pending] = useActionState<S, FormData>(action, initial);
  const ref = useRef<HTMLFormElement>(null);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      const data = new FormData(event.currentTarget, submitter);
      startTransition(() => formAction(data));
    },
    [formAction],
  );

  useEffect(() => {
    const form = ref.current;
    if (!state || !form) return;
    if (state.ok) {
      for (const input of form.querySelectorAll<HTMLInputElement>('input[type="file"], input[type="password"]')) input.value = '';
    } else {
      const invalid = form.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (invalid) invalid.focus();
      else form.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
    }
  }, [state]);

  return { state, pending, formRef: ref, formAction, onSubmit };
}
