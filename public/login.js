document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const error = document.querySelector('#login-error');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Login gagal.');
    location.replace('/');
  } catch (failure) {
    error.textContent = failure.message;
  } finally { button.disabled = false; }
});
