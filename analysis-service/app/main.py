from secrets import compare_digest

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from .config import settings
from .uploads import router as uploads_router

app = FastAPI(title="InsightFlow Analysis Service", version="0.1.0")
app.state.settings = settings
app.include_router(uploads_router)


@app.middleware("http")
async def protect_analysis_endpoints(request: Request, call_next):
    expected = settings.analysis_service_token
    if expected and request.url.path != "/health":
        supplied = request.headers.get("x-analysis-token", "")
        if not compare_digest(supplied, expected):
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "analysis-service"}
