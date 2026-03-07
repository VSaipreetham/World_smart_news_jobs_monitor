const http = require('http');

http.get('http://localhost:8000/api/company-intel?company=John+Deere', (resp) => {
    let data = '';
    resp.on('data', (chunk) => { data += chunk; });
    resp.on('end', () => { console.log("Response:", data); });
}).on("error", (err) => {
    console.log("Error: " + err.message);
});
