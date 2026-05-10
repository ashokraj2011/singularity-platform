from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import User, LocalCredential
from app.auth.password import verify_password
from app.auth.jwt import create_access_token
from app.auth.schemas import LoginRequest, LoginResponse, TokenUserOut
from app.auth.deps import get_current_user
from app.audit.service import record_event

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/local/login", response_model=LoginResponse)
async def local_login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(User).where(User.email == body.email, User.is_local_account == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()

    if not user:
        await record_event(db, event_type="failed_login", payload={"email": body.email, "reason": "user_not_found"})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    cred_result = await db.execute(select(LocalCredential).where(LocalCredential.user_id == user.id))
    cred = cred_result.scalar_one_or_none()

    if not cred or not verify_password(body.password, cred.password_hash):
        await record_event(db, event_type="failed_login", payload={"email": body.email, "reason": "bad_password"})
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is not active")

    cred.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    token = create_access_token(user.id, user.email, user.is_super_admin)
    await record_event(db, actor_user_id=user.id, event_type="local_login", payload={"email": user.email})

    return LoginResponse(
        access_token=token,
        user=TokenUserOut(id=user.id, email=user.email, display_name=user.display_name, is_super_admin=user.is_super_admin),
    )


