export async function callApi(endpoint, data = {}) {
    let res;
    if (Object.keys(data).length === 0) {
        res = await fetch(endpoint);
    } else {
        res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }
    const json = await res.json();
    if (!res.ok) {
        const msg = json.error || `Request failed (${res.status})`;
        throw new Error(msg);
    }
    return json;
}
