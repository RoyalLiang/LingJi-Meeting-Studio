const reference = new URL(location.href).searchParams.get('reference');
if (/^[a-f0-9]{64}$/.test(reference || '')) {
  const target = new URL(document.getElementById('content-report').href);
  target.searchParams.set('reference', reference);
  document.getElementById('content-report').href = target.href;
}
