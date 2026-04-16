def handler(request):
    # Simple test function for Vercel Python runtime
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": '{"ok": true, "msg": "hello from Vercel Python function"}'
    }
