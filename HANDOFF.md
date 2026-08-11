# UX/UI rules for this codebase

50 rules, written from the failures this app actually shipped. Each one exists because
a real user hit it, or because it is the complaint people make most often about apps
like this one. They are ordered by how badly a violation hurts, not by topic size.

Anything below phrased as "never" is not a style preference. A change that breaks one
of these is not done, however correct the logic is.

---

## A. Nothing is allowed to cover the app (1–6)

**1. No permanent overlay, ever.** A fixed element pinned to the top of the viewport
covers the header, the HUD and the first row of controls on a phone. This app shipped
exactly that — a 35vh debug banner — and the result read as "the icons don't exist and
the buttons don't work." Both were fine; they were underneath something.

**2. `pointer-events: none` does not make an overlay safe.** It stops the overlay from
eating taps, but the user still cannot see what they are tapping. If it hides content,
it is broken whether or not clicks pass through.

**3. Floating messages anchor to the bottom, above the tab bar.** Top-anchored means
covering the title and primary actions. `.boot-failure` is the pattern to copy:
`bottom: 84px`, two lines maximum, one action.

**4. Respect the z-index ladder, and add to it deliberately.** The current one:
`.lesson-screen` 500 → `.preview-overlay` 800 → `.loading-overlay` 900 →
`.boot-failure` 950 → `.modal` 1000 → `.confetti` 9999 (cosmetic, `pointer-events:
none`). A new layer picks a number inside this scheme and gets added to this list. No
`z-index: 99999` to win an argument with a layer you did not look up.

**5. An overlay that blocks input must look like it blocks input.** Dim the background,
centre the content. `.loading-overlay` and `.modal` do this. A transparent full-screen
element that silently swallows every tap is the single worst bug class in this app.

**6. Transient messages never reflow the page.** Either overlay them or reserve their
space. Content that jumps as a message appears moves the button out from under a
finger already on its way down.

---

## B. Every control responds to every press (7–14)

**7. A control that cannot act says why.** Never `return` silently. "Build learning
path" used to return on empty input and read as a dead button; it now says what is
missing. Silent return is the same bug as no listener, from the user's side.

**8. Something visible changes within 100ms of a press.** A press with no acknowledgement
gets pressed again, and the second press is the one that causes damage.

**9. A disabled control states its condition.** Either near the control or in the press
handler. A greyed-out button with no explanation is a dead end with extra steps.

**10. In-flight work shows a state and cannot be double-submitted.** `authSubmitBtn` is
the pattern: `disabled = true`, label swapped to "Signing in…", restored in `finally`.
Screen-blocking overlays (`showMessage`) count as a guard; nothing else does.

**11. Resolve clicks with `closest()`, not `e.target`.** A tap lands on the `<svg>` or
`<path>` inside a button, not on the element holding the `data-` attribute. Every
delegated handler that reads `e.target.dataset` is one icon away from being dead.

**12. Tap targets are at least 44×44px, including invisible padding.** Not the icon
size — the hit area. `.course-delete`, `.course-rename` and `.auth-password-toggle` are
all 44×44 for this reason.

**13. Clickable things look clickable; non-clickable things do not.** Course titles now
carry `.stat-value-button` plus a "tap to rename" label because a plain heading that
happens to be tappable is undiscoverable. The inverse also holds: never style static
text like a button.

**14. No screen is a dead end.** Every screen has a visible way back that does not
require the browser's back button or a reload. Check every state, including
mid-lesson, mid-error and mid-review.

---

## C. Failure is a feature (15–22)

**15. Never fail silently.** A caught exception with an empty `catch` block, a rejected
promise nobody surfaces, an `if (!x) return` on the happy path — all of these produce
"nothing happens when I press it", the least debuggable report there is.

**16. An error says what happened and what to do next.** "Couldn't read that file. Make
sure it's a valid PDF" is usable. "Error" is not. If there is a workaround, name it —
the PDF failure path points at "paste the text instead."

**17. No raw internals reach the user.** No stack traces, no `undefined`, no `null`, no
`[object Object]`, no HTTP status codes standing alone, no bare `-`. If a value could
be empty or malformed, it gets a fallback before it is rendered.

**18. Preserve the user's input when something fails.** Never clear a textarea or a
form on error. The one place input is cleared is `courseNameInput`, on success only,
and that is deliberate.

**19. A partial boot must announce itself.** `app.js` sets `window.__appBooted` on its
last line; `index.html` checks it 1.5s after load and shows a Reload strip if it is
missing. Without this, a script that dies halfway leaves a page that looks perfect and
does nothing. Keep this alive — do not let listener registration move after it.

**20. Degrade one feature, not the whole app.** The `pdfjsLib` guard is right: a blocked
PDF library disables PDF upload and leaves paste working. An unguarded call at the top
of the file takes down every listener below it.

**21. Recovery is one tap.** Reload button, retry button, "back to my courses". Never
ask the user to clear a cache, hard-refresh, or reopen the app.

**22. Diagnostics go to `console.error`, never to the screen.** If you need on-screen
telemetry to chase a device-specific bug, it is temporary, it is bottom-anchored, it is
dismissible, and it is removed in the same branch it was added. The banner that started
all of this survived four commits.

---

## D. The user owns their content (23–29)

**23. Anything generated automatically is editable.** Model output, filenames, defaults.
Course titles came from the model or the filename with no way to change them; a file
named `-.pdf` became a course permanently called `-`.

**24. Never display a name the user cannot change.** If it is on screen and it belongs
to them, there is a path to rename it. Two paths is better — the pencil on the library
card and the title above the path both reach `renameCourse`.

**25. Validate names for real content, not just non-empty.** `cleanTitle()` requires at
least one `\p{L}` or `\p{N}`, so `-`, `---` and `   ` are rejected. Use Unicode
classes, never `[a-zA-Z]` — Hebrew, Arabic and Cyrillic titles are normal here.

**26. A rename updates every copy in one call.** Supabase row, the `library` array, and
`courseData.courseName` if that course is open. Three copies drifting apart is how a
rename "doesn't work" on one screen and works on another.

**27. Destructive actions confirm, and name the thing.** `Delete "Biology — Chapter 4"?
This cannot be undone.` Never a bare "Are you sure?" — the user needs to know which
one they are about to lose.

**28. Never lose work.** Progress writes are fire-and-forget but they do fire on every
change. A failed save logs and keeps going; it never resets in-memory state.

**29. Empty states teach the next action.** `libraryEmpty` says "Upload a document to
build your first one," not "No courses." An empty screen with a noun on it is a
dead end.

---

## E. Forms (30–36)

**30. Inputs are 16px or larger. Non-negotiable on iOS.** Below 16px, Safari zooms the
page on focus, which shifts the layout and eats the next tap. Already enforced on
`.auth-input`; enforce it on anything new.

**31. Every field has a real `<label>`.** A placeholder is not a label — it disappears
the moment the user types, and screen readers treat it as a hint. `courseNameInput`
has both.

**32. Optional fields say "Optional", and say what happens if left blank.** Users leave
fields blank out of fear, not preference. The course-name hint says a name will be
written for them and can be changed later.

**33. Validate on submit, not on keystroke.** Marking a field invalid while someone is
still typing their third character is hostile.

**34. Field errors appear next to the field.** A form-level error for a field-level
problem makes the user hunt. `authError` sits directly above the submit button for
this reason.

**35. Set `type`, `autocomplete` and `inputmode` correctly.** `type="email"` +
`autocomplete="email"`, `autocomplete="current-password"`, `autocomplete="off"` on the
course name. This is the difference between one tap and twelve on a phone.

**36. Enter submits; Escape closes.** Any form the user can fill from a keyboard.

---

## F. Phones are the primary target (37–42)

**37. Honour the safe-area insets.** `.bottom-nav` uses
`calc(6px + env(safe-area-inset-bottom, 0px))`. Without it the home indicator sits on
top of the tab bar on every notched iPhone.

**38. Nothing required lives below the fold on first paint.** The primary action of a
screen is reachable without scrolling at 390×844.

**39. No horizontal scroll, at any width.** Wide content — tables, diagrams, code —
scrolls inside its own container, never the page body.

**40. Never put behaviour behind hover.** Hover does not exist on touch. Anything
revealed by `:hover` is decoration only; `.course-rename:hover` changes colour, and
the button is visible either way.

**41. Preserve scroll position across state changes.** Re-rendering a list must not jump
the user back to the top. `scrollToCurrentNode()` moves the view deliberately; nothing
else should move it by accident.

**42. Verify at 390×844 and again at 320px wide.** Both, every time. The 320px case is
where fixed widths and long unbroken strings break the layout.

---

## G. Accessibility is not a later phase (43–48)

**43. Keyboard focus is always visible.** Removing `outline` requires a replacement.
Four `:focus` rules in this file do `outline: none` and swap the border colour, which
works for inputs — buttons currently have no focus style at all. Fix that before
adding more.

**44. Async status changes are announced.** Loading, errors and results need
`aria-live` (`polite` for status, `assertive` for errors). This app has none yet, which
means a screen-reader user gets no signal that a course is being generated.

**45. Interactive elements are real `<button>`s and `<a>`s.** Not `<div onclick>`. Free
keyboard access, free focus, free semantics. Every control in `index.html` follows
this — keep it that way.

**46. Text contrast is at least 4.5:1 against its own background.** Check
`--duo-text-light` on coloured surfaces specifically; that is where this palette gets
close to the line.

**47. Respect `prefers-reduced-motion`.** `prefersReducedMotion()` already gates the
unlock burst and smooth scrolling. Any new animation checks it too.

**48. Direction follows the content, not the chrome.** Course content sets `dir="rtl"`
per `RTL_LANGUAGES` while the UI stays LTR. Never hardcode `left`/`right` for anything
holding user content — use logical properties or the existing `dir` mechanism.

---

## H. Shipping discipline (49–50)

**49. Every UI change is verified in a real browser at phone size before it is claimed
done.** Load the page, take a screenshot, look at it. Both bugs in this handoff's
history — the covering banner and the untouchable title — were invisible in code review
and obvious in a 390px screenshot.

**50. Check these rules against the diff, not against intent.** The banner that broke
the app was added by someone trying to fix the app, and it passed every review because
everyone knew what it was *for*. Read the diff as a user who has never seen the commit
message.

---

## Known violations, as of this handoff

Open debt, not hypotheticals — each names the rule it breaks:

- **Rule 43** — buttons have no focus style. Only inputs do, via border colour.
- **Rule 44** — no `aria-live` anywhere. `#loadingOverlay` and `#authError` are the
  two that need it most.
- **Rules 16/27** — rename, delete, reset and every error use native `prompt()`,
  `confirm()` and `alert()`. They satisfy the rules' substance but cannot be styled,
  cannot be made RTL, and look like a browser warning rather than part of the app.
  Replacing them with in-app dialogs is the largest single UX win left.
- **Rule 46** — palette contrast has not been measured, only eyeballed.
