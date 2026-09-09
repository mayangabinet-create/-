// Exercise the shipping recovery controller with fake DOM/auth boundaries.
// No real account, password change, email, or network request is made.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../reset-password.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup({ session = {}, linkError = false, updateError = null, updateThrows = false, cdn = true, deferred = false, sessionThrows = false, mailError = null } = {}) {
    const ids = ['passwordForm', 'requestForm', 'feedback', 'newPassword', 'confirmPassword', 'savePassword', 'resetEmail', 'sendReset', 'resetTitle', 'resetDescription', 'returnLink'];
    const elements = Object.fromEntries(ids.map(id => [id, {
        hidden: ['passwordForm', 'requestForm', 'feedback'].includes(id),
        value: '', textContent: '', dataset: {}, disabled: false,
        listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
        focus() {}, reportValidity() { return true; },
        reset() { elements.newPassword.value = ''; elements.confirmPassword.value = ''; },
    }]));
    const updates = [], emails = [], cleared = [];
    let finishUpdate;
    const auth = {
        async getSession() { if (sessionThrows) throw Error('offline'); return { data: { session }, error: null }; },
        async updateUser(data) {
            updates.push(data);
            if (updateThrows) throw Error('offline');
            if (deferred) return new Promise(resolve => { finishUpdate = resolve; });
            return { error: updateError };
        },
        async resetPasswordForEmail(email, options) { emails.push({ email, options }); return { error: mailError }; },
    };
    const context = {
        document: { getElementById: id => elements[id] }, URL, URLSearchParams,
        sessionStorage: { removeItem() {} },
        window: {
            location: { hash: linkError ? '#error_code=otp_expired' : '', search: '', pathname: '/-/reset-password.html', href: 'https://example.test/-/reset-password.html' },
            history: { replaceState: (...args) => cleared.push(args) },
            supabase: cdn ? { createClient: () => ({ auth }) } : undefined,
        },
    };
    vm.runInNewContext(source, context);
    await tick();
    return {
        elements, updates, emails, cleared,
        submit: id => elements[id].listeners.submit({ preventDefault() {} }),
        fill(password = 'test-only-password', confirm = password) { elements.newPassword.value = password; elements.confirmPassword.value = confirm; },
        finish: result => finishUpdate(result),
    };
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
await test('a valid session opens the password form and clears auth URL data', async () => {
    const s = await setup(); assert.equal(s.elements.passwordForm.hidden, false); assert.equal(s.cleared[0][2], '/-/reset-password.html');
});
await test('no session cannot change a password', async () => {
    const s = await setup({ session: null }); s.fill(); await s.submit('passwordForm'); assert.equal(s.updates.length, 0); assert.equal(s.elements.requestForm.hidden, false);
});
await test('an expired link is rejected even if an older session exists', async () => {
    const s = await setup({ linkError: true }); s.fill(); await s.submit('passwordForm'); assert.equal(s.updates.length, 0); assert.equal(s.elements.passwordForm.hidden, true);
});
await test('mismatched passwords do not reach auth', async () => {
    const s = await setup(); s.fill('test-only-password', 'different-password'); await s.submit('passwordForm'); assert.equal(s.updates.length, 0); assert.match(s.elements.feedback.textContent, /do not match/);
});
await test('short passwords do not reach auth', async () => {
    const s = await setup(); s.fill('short'); await s.submit('passwordForm'); assert.equal(s.updates.length, 0);
});
await test('success requires a successful auth response and clears the fields', async () => {
    const s = await setup(); s.fill(); await s.submit('passwordForm'); assert.equal(s.updates.length, 1); assert.equal(s.elements.resetTitle.textContent, 'Password updated'); assert.equal(s.elements.newPassword.value, ''); assert.equal(s.elements.passwordForm.hidden, true);
});
await test('double submit does not issue two password updates', async () => {
    const s = await setup({ deferred: true }); s.fill(); const first = s.submit('passwordForm'); await s.submit('passwordForm'); assert.equal(s.updates.length, 1); s.finish({ error: null }); await first;
});
await test('a server rejection does not show success', async () => {
    const s = await setup({ updateError: { code: 'same_password' } }); s.fill(); await s.submit('passwordForm'); assert.match(s.elements.feedback.textContent, /different/); assert.equal(s.elements.passwordForm.hidden, false);
});
await test('expired sessions expose a new-link form', async () => {
    const s = await setup({ updateError: { status: 401 } }); s.fill(); await s.submit('passwordForm'); assert.equal(s.elements.requestForm.hidden, false); assert.equal(s.elements.newPassword.value, '');
});
await test('network failures leave the form retryable', async () => {
    const s = await setup({ updateThrows: true }); s.fill(); await s.submit('passwordForm'); assert.equal(s.elements.savePassword.disabled, false); assert.match(s.elements.feedback.textContent, /could not be confirmed/);
});
await test('new emails keep the project subdirectory', async () => {
    const s = await setup({ session: null }); s.elements.resetEmail.value = 'test@example.test'; await s.submit('requestForm'); assert.equal(s.emails[0].options.redirectTo, 'https://example.test/-/reset-password.html'); assert.match(s.elements.feedback.textContent, /If that account exists/);
});
await test('email errors are visible and retryable', async () => {
    const s = await setup({ session: null, mailError: { status: 429 } }); s.elements.resetEmail.value = 'test@example.test'; await s.submit('requestForm'); assert.equal(s.elements.feedback.dataset.kind, 'error'); assert.equal(s.elements.sendReset.disabled, false);
});
await test('missing SDK displays a useful error without enabling changes', async () => {
    const s = await setup({ cdn: false }); assert.equal(s.elements.passwordForm.hidden, true); assert.match(s.elements.resetDescription.textContent, /could not load/);
});
await test('session initialization errors expose recovery instead of a spinner', async () => {
    const s = await setup({ sessionThrows: true }); assert.equal(s.elements.requestForm.hidden, false);
});
await test('both app entry points use the explicit redirect helper', async () => {
    assert.match(app, /sendPasswordReset\(currentUser.email\)/);
    assert.match(app, /await sendPasswordReset\(email\)/);
    assert.equal((app.match(/resetPasswordForEmail\(/g) || []).length, 1);
    const scope = { window: { location: { origin: 'https://example.test', pathname: '/renamed-app/index.html' } }, supabaseClient: { auth: { resetPasswordForEmail: (email, options) => options } } };
    for (const name of ['appBaseUrl', 'passwordResetUrl', 'sendPasswordReset']) {
        const start = app.indexOf('        function ' + name + '(');
        const end = app.indexOf('\n        }', start) + '\n        }'.length;
        vm.runInNewContext(app.slice(start, end), scope);
    }
    assert.equal(scope.sendPasswordReset('test@example.test').redirectTo, 'https://example.test/renamed-app/reset-password.html');
});
console.log(`${passed} password recovery tests passed`);
