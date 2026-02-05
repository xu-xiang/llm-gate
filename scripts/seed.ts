import { spawn } from 'child_process';

const CREDS_1 = JSON.stringify({
    access_token: "fake_token_1",
    refresh_token: "fake_refresh_1",
    alias: "Account 1",
    token_type: "Bearer",
    expiry_date: Date.now() + 3600000
});

const CREDS_2 = JSON.stringify({
    access_token: "fake_token_2",
    refresh_token: "fake_refresh_2",
    alias: "Account 2",
    token_type: "Bearer",
    expiry_date: Date.now() + 3600000
});

function run(cmd: string) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, { shell: true, stdio: 'inherit' });
        p.on('close', code => code === 0 ? resolve(code) : reject(code));
    });
}

async function main() {
    console.log('🌱 Seeding local KV...');
    try {
        await run(`npx wrangler kv:key put --binding=AUTH_STORE --local "./oauth_creds_1.json" '${CREDS_1}'`);
        await run(`npx wrangler kv:key put --binding=AUTH_STORE --local "./oauth_creds_2.json" '${CREDS_2}'`);
        console.log('✅ Seeding complete.');
    } catch (e) {
        console.error('❌ Seeding failed:', e);
        process.exit(1);
    }
}

main();
