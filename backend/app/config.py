from functools import lru_cache
from urllib.parse import unquote

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    project_name: str = "주소산업 공고 자동수집·자동분류 MVP"
    api_prefix: str = "/api"

    database_url: str = "postgresql+psycopg://address_app:address_app@db:5432/address_notices"

    openai_api_key: str | None = None
    openai_model: str = "gpt-4.1-mini"
    auth_secret_key: str = "change-this-local-secret"
    admin_email: str = "admin@example.com"
    admin_password: str = "admin1234"

    g2b_api_endpoint: str = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService"
    g2b_api_key: str | None = None
    g2b_api_operations: str = (
        "getBidPblancListInfoServcPPSSrch,"
        "getBidPblancListInfoThngPPSSrch,"
        "getBidPblancListInfoCnstwkPPSSrch,"
        "getBidPblancListInfoEtcPPSSrch,"
        "getBidPblancListInfoFrgcptPPSSrch"
    )
    g2b_num_rows: int = 100
    g2b_inqry_divs: str = "1,2"
    g2b_max_pages_per_operation: int = 0
    g2b_recent_window_days: int = 30
    g2b_deadline_window_days: int = 30
    g2b_full_collect_enabled: bool = False
    g2b_keyword_precollect_enabled: bool = True
    g2b_keyword_precollect_max_terms: int = 0
    g2b_keyword_precollect_max_pages_per_term: int = 0
    g2b_keyword_precollect_inqry_divs: str = "1,2"
    g2b_auto_collect_enabled: bool = True
    g2b_auto_collect_interval_minutes: int = 60
    g2b_auto_collect_on_startup: bool = True
    g2b_auto_collect_run_ai: bool = False

    cors_origins: str = "http://localhost:3000,http://localhost:5173"

    seed_sample_data: bool = False

    @field_validator("openai_api_key")
    @classmethod
    def blank_to_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("g2b_api_key")
    @classmethod
    def normalize_g2b_api_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        return unquote(stripped) if "%" in stripped else stripped

    @property
    def g2b_operations(self) -> list[str]:
        return [operation.strip() for operation in self.g2b_api_operations.split(",") if operation.strip()]

    @property
    def g2b_inqry_div_list(self) -> list[str]:
        values = [value.strip() for value in self.g2b_inqry_divs.split(",") if value.strip()]
        return [value for value in values if value in {"1", "2"}] or ["1"]

    @property
    def g2b_keyword_precollect_inqry_div_list(self) -> list[str]:
        values = [value.strip() for value in self.g2b_keyword_precollect_inqry_divs.split(",") if value.strip()]
        return [value for value in values if value in {"1", "2"}] or ["1"]

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
