/* Isolated from the learning app: recovery never starts a course or onboarding. */
(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    const passwordForm = byId('passwordForm');
    const requestForm = byId('requestForm');
    const feedback = byId('feedback');
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    // Capture errors before the SDK processes and clears the URL. Never render
    // raw URL parameters, which may contain untrusted text or auth tokens.
    const linkFailed = ['error', 'error_code'].some(key => fragment.has(key) || query.has(key));
    let auth;
    let ready = false;
    let busy = false;

    function message(text, error = false) {
        feedback.textContent = text;
        feedback.dataset.kind = error ? 'error' : 'info';
        feedback.hidden = false;
    }

    function requestNewLink(text) {
        ready = false;
        passwordForm.hidden = true;
        passwordForm.reset();
        requestForm.hidden = false;
        byId('resetTitle').textContent = 'Get a new reset link';
        byId('resetDescription').textContent = text;
    }

    function clearAuthUrl() {
        window.history.replaceState(null, '', window.location.pathname);
    }

    passwordForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!ready || busy) return;
        const password = byId('newPassword').value;
        const confirm = byId('confirmPassword').value;
        if (password.length < 8) { message('Use at least 8 characters.', true); return; }
        if (password !== confirm) {
            message('The passwords do not match. Please try again.', true);
            byId('confirmPassword').focus();
            return;
        }
        busy = true;
        const button = byId('savePassword');
        button.disabled = true;
        button.textContent = 'Saving…';
        feedback.hidden = true;
        try {
            const { error } = await auth.updateUser({ password });
            if (error) {
                if (['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt'].includes(error.code) || error.status === 401 || error.status === 403) {
                    requestNewLink('Your reset session has expired. Request a new email below.');
                } else {
                    message(error.code === 'same_password'
                        ? 'Choose a password different from your current one.'
                        : 'Could not save that password. Check the password requirements and try again.', true);
                }
                return;
            }
            ready = false;
            passwordForm.reset();
            passwordForm.hidden = true;
            byId('resetTitle').textContent = 'Password updated';
            byId('resetDescription').textContent = 'Your new password is saved. You can return to your courses.';
            byId('returnLink').textContent = 'Return to the app';
            byId('returnLink').focus();
            try { sessionStorage.removeItem('pending_action'); } catch (_) {}
        } catch (_) {
            message('Connection problem. Your password change could not be confirmed. Try again.', true);
        } finally {
            busy = false;
            button.disabled = false;
            button.textContent = 'Save new password';
        }
    });

    requestForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!auth || busy) return;
        const email = byId('resetEmail').value.trim();
        if (!email || !requestForm.reportValidity()) return;
        busy = true;
        const button = byId('sendReset');
        button.disabled = true;
        button.textContent = 'Sending…';
        try {
            const redirectTo = new URL('reset-password.html', window.location.href).href;
            const { error } = await auth.resetPasswordForEmail(email, { redirectTo });
            message(error
                ? 'Could not send the email. Please wait a moment and try again.'
                : 'If that account exists, a reset link is on its way. Open the newest email.', !!error);
        } catch (_) {
            message('Could not send the email. Check your connection and try again.', true);
        } finally {
            busy = false;
            button.disabled = false;
            button.textContent = 'Send a new reset link';
        }
    });

    async function initialize() {
        if (!window.supabase) {
            clearAuthUrl();
            byId('resetDescription').textContent = 'The sign-in service could not load. Check your connection and reopen the link from your email.';
            return;
        }
        auth = window.supabase.createClient(
            'https://kgkdkkqoebnpahvetwzk.supabase.co',
            'sb_publishable_qE7c9BFhruGYYi_QgP4i4w_1T86fift'
        ).auth;
        try {
            // getSession waits for implicit-flow URL processing. Clear the
            // fragment only afterwards, so the SDK can consume the link first.
            const { data, error } = await auth.getSession();
            clearAuthUrl();
            if (linkFailed || error || !data?.session) {
                requestNewLink('This reset link is missing, expired or has already been used. Request a fresh one below.');
                return;
            }
            ready = true;
            passwordForm.hidden = false;
            byId('resetDescription').textContent = 'Use at least 8 characters. Enter the same password in both fields.';
            byId('newPassword').focus();
        } catch (_) {
            clearAuthUrl();
            requestNewLink('We could not verify this reset link. Check your connection or request a new one.');
        }
    }
    initialize();
})();
