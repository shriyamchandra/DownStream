export async function callApi(endpoint, data = {}) {
    if (Object.keys(data).length === 0) {
        const res = await fetch(endpoint);
        return await res.json();
    }
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return await res.json();
}
