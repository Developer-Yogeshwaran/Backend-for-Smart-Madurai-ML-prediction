def handler(request, context=None):
    # Simple test function for Vercel Python runtime — returns JSON string
    return ("{" + '"ok": true, "msg": "hello from Vercel Python function"' + "}", 200, {"Content-Type": "application/json"})

# Alias `app` so Vercel can detect either `handler` or `app` at module level.
app = handler
