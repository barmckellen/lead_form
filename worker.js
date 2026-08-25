export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/api/config') {
            return new Response(JSON.stringify({
                SUPABASE_URL: env.SUPABASE_URL || '',
                SUPABASE_KEY: env.SUPABASE_KEY || '',
                SUPABASE_SCHEMA: env.SUPABASE_SCHEMA || 'leads',
                N8N_WEBHOOK_URL: env.N8N_WEBHOOK_URL || ''
            }), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
            });
        }

        return env.ASSETS.fetch(request);
    }
};
