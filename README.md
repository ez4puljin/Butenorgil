# Бүтэн-Оргил ERP систем

Захиалга, логистик, нийлүүлэгч, тооллого, KPI, Erkhet автомат системийг нэгтгэсэн ERP.

## Ерөнхий мэдээлэл

- **Backend**: FastAPI + SQLAlchemy + SQLite
- **Frontend**: React + Vite + TypeScript + Tailwind CSS
- **Erkhet Automation**: Python + Playwright + Selenium (тусдаа venv)
- **Default port**: Backend `8000`, Frontend `3000` (HTTPS) эсвэл `3001` (HTTP)

---

## Урьдчилсан шаардлага

Шинэ PC дээр суулгахаас өмнө дараах программуудыг суулгана уу:

### 1. Python 3.11+ (backend + erkhet-automation)
- https://www.python.org/downloads/ (Windows installer)
- Суулгахдаа **"Add Python to PATH"** чеклэх

### 2. Node.js 20+ (frontend)
- https://nodejs.org/ (LTS хувилбар)

### 3. Git
- https://git-scm.com/downloads

### 4. Google Chrome (Erkhet automation шаардана)
- https://www.google.com/chrome/

---

## Суулгах алхмууд

### 1. Repo татах

```bash
git clone https://github.com/ez4puljin/Butenorgil.git
cd Butenorgil
```

### 2. Backend тохиргоо

```bash
cd backend

# Virtual environment үүсгэх
python -m venv .venv

# Идэвхжүүлэх (Windows cmd/PowerShell)
.venv\Scripts\activate

# (Mac/Linux)
# source .venv/bin/activate

# Dependencies суулгах
pip install -r requirements.txt
```

**Backend асаах:**

```bash
# backend folder дотор байхдаа
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Backend эхний удаа асаахад:
- `app/data/` folder автомат үүснэ
- SQLite DB файл үүснэ (`app/data/app.db`)
- Admin хэрэглэгч автомат seed хийгдэнэ

**Default admin нэвтрэх:**
- Username: `admin`
- Password: Backend лог дээр харагдана, эсвэл `backend/app/services/seed.py` дотроос шалгана

---

### 3. Frontend тохиргоо

```bash
cd frontend

# Dependencies суулгах
npm install
```

#### HTTPS (зөвлөсөн, PWA ажиллахын тулд)

SSL cert үүсгэх:

```bash
# mkcert суулгах (Windows: choco install mkcert)
# https://github.com/FiloSottile/mkcert

mkcert -install

# Frontend folder дотор
mkdir certs
cd certs

# IP хаяг + localhost-тэй cert үүсгэх (IP-г өөрийнхөөрөө соль)
mkcert 192.168.1.198 localhost 127.0.0.1
```

Үүсгэсэн `.pem` файлуудыг `frontend/certs/` дотор байршуулна. Файлын нэр: `192.168.1.198+2.pem`, `192.168.1.198+2-key.pem`. Хэрэв өөр IP бол `frontend/vite.config.ts`-д зам нь зааж өг.

**Frontend асаах (HTTPS port 3000):**

```bash
npm run dev
```

#### HTTP (хялбар тохиргоо)

Хэрэв HTTPS шаардлагагүй бол:

```bash
set VITE_NO_HTTPS=1
npx vite --host 0.0.0.0 --port 3001
```

---

### 4. Erkhet Automation тохиргоо

Erkhet системээс тайлан автомат татаж Messenger руу илгээх бие даасан систем.

```bash
cd erkhet-automation

# Virtual environment
python -m venv venv
venv\Scripts\activate

# Dependencies
pip install -r requirements.txt

# Playwright browser суулгах
playwright install chromium
```

#### `.env` файл үүсгэх

`erkhet-automation/.env.example` файлыг `.env` болгож хуулаад утгуудыг бөглөнө:

```bash
copy .env.example .env
```

**.env агуулга:**

```env
# Erkhet нэвтрэх
ERKHET_URL=https://erkhet.bto.mn
ERKHET_USERNAME=your@email.com
ERKHET_PASSWORD=yourpassword
ERKHET_COMPANY_ID=9514593312

# Report тохиргоо
REPORT_TYPE=inventory_cost
REPORT_PERIOD=yesterday
REPORT_LOCATIONS=01,02,10,11,12
REPORT_ACCOUNT=150101

# Facebook Messenger
MESSENGER_ENABLED=true
FB_EMAIL=your_fb_id
FB_PASSWORD=your_fb_password
MESSENGER_GROUP_MILKO=9916235521763877
MESSENGER_GROUP_ALTANJOLUU=1306445024219951

# Scheduler
SCHEDULE_HOUR=8
SCHEDULE_MINUTE=0
```

#### Facebook Messenger анхны setup

Messenger автомат илгээх үйлдэл нь undetected-chromedriver ашигладаг. Анх нэг удаа гарын авлагаар нэвтрэнэ:

```bash
# test_messenger.py ажиллуулж FB нэвтрэх (cookie хадгалагдана)
python test_messenger.py
```

Хөтөч нээгдэхэд Facebook руу нэвтэрнэ үү. Cookie `cookies/` folder дотор хадгалагдана.

---

### 5. Startup script (Windows)

Хөгжүүлэлтийн горимд хялбар асаахын тулд `start.bat` (repo root дээр):

```bat
@echo off
start cmd /k "cd backend && .venv\Scripts\activate && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
start cmd /k "cd frontend && npm run dev"
```

Ажиллуулахдаа: `start.bat` товшино уу.

---

## Нэвтрэх

1. Browser-оо нээж `https://192.168.1.198:3000` (эсвэл `http://localhost:3001`) руу орно уу
2. Admin хэрэглэгчээр нэвтэрнэ
3. Хэрэглэгч нэмэх: **Удирдлага** цэснээс

---

## Гол цэсүүд (permission тус бүрээр)

| Цэс | Зорилго | Permission |
|-----|---------|------------|
| Захиалга | PO үүсгэх, бренд-төвтэй dashboard, машины ачилт | admin, supervisor, manager, warehouse_clerk |
| Хянах самбар | Ерөнхий статистик | admin, supervisor, manager, accountant |
| Тайлан | Бэлэн тайлангууд | admin, supervisor, manager |
| Файл оруулалт | Эксэл импорт (Эрхэт, Эрксэс, Мастер гм.) | admin, supervisor, manager |
| Авлага | Авлагын тайлан + SMS | admin, supervisor, accountant |
| Нийлүүлэгч | Нийлүүлэгч CRUD + brand mapping | admin, supervisor |
| Логистик | Машины парк + top list | admin, supervisor, manager |
| Календар | Үйл явдлын календар | Бүгд |
| Удирдлага | Хэрэглэгч, эрх | admin |
| KPI | Өдрийн даалгавар, зөвшөөрөл, тохиргоо | admin, supervisor, manager, etc. |
| Шинэ бараа | New product submission | admin, supervisor, manager |
| Борлуулалтын тайлан | Бүс тус бүрийн импорт + dashboard | admin, supervisor, manager, accountant |
| Тооллогоны тайлан | 8 агуулахын тооллого + KPI auto-assign | admin, supervisor, manager |
| **Erkhet автомат** | **Эрхэт тайлан автомат + Messenger** | admin, supervisor |

---

## Нийтлэг асуудлууд

### 1. Chrome дээр "Not secure" гэж харагдана (HTTPS self-signed cert)

Windows certificate manager-т rootCA суулгах:

1. `Win+R` → `certmgr.msc`
2. **Trusted Root Certification Authorities** → **Certificates** → Right-click → **Import**
3. `mkcert` rootCA-г browse (ихэвчлэн `%LOCALAPPDATA%\mkcert\rootCA.pem`)
4. Chrome бүрэн хаагаад дахин нээх

Эсвэл түр шийдэл: Chrome дээр хуудасны хаана ч дарж `thisisunsafe` гэж бичих.

### 2. Backend start хийхэд `sqlalchemy` module not found

Virtual environment идэвхжээгүй байна. Шалгах:

```bash
cd backend
.venv\Scripts\activate  # Windows
pip list | findstr sqlalchemy
```

Хэрэв virtual env зөв асаагдсан байвал `SQLAlchemy 2.0.x` харагдана.

### 3. Frontend порт 3000 дээр өөр app ажиллаж байна

`frontend/vite.config.ts` дотор port-г өөрчлөх эсвэл:

```bash
npx vite --host 0.0.0.0 --port 3088
```

### 4. Erkhet тайлан татахад удаан (3-5 минут)

Эрхэт сервер удаан хариу өгдөг. Timeout нь 10 минут тохируулагдсан. Хэрэв үргэлжлүүлэн асуудалтай бол `erkhet-automation/erkhet/reports.py` дотор `timeout` параметрийг нэмэгдүүлэх.

### 5. Messenger илгээхэд алдаа

- `erkhet-automation/cookies/` folder-ийг устгаад `test_messenger.py` ажиллуулж дахин нэвтрэх
- FB group ID зөв эсэхийг шалгах (messenger.com/t/{GROUP_ID}-аас хуулж авна)

### 6. Database reset хэрэгтэй бол

```bash
# Backend зогсоо
# DB файл устгах
del backend\app\data\app.db
# Backend дахин асаах (шинэ DB + admin seed автомат үүснэ)
```

---

## Production deployment

Windows Server дээр background service болгох:

1. **Backend**: Task Scheduler-аар `backend/startup.bat` ажиллуулна
2. **Frontend**: `npm run build` → `dist/` folder-г nginx/IIS-ээр serve
3. **Erkhet automation scheduler**: `erkhet-automation/scheduler.py install` (Admin PowerShell)

---

## Folder бүтэц

```
Butenorgil/
├── backend/                # FastAPI backend
│   ├── app/
│   │   ├── api/           # API endpoints (routers)
│   │   ├── models/        # SQLAlchemy models
│   │   ├── schemas/       # Pydantic schemas
│   │   ├── services/      # Бизнес логик
│   │   ├── scripts/       # Excel import scripts
│   │   ├── core/          # Config, DB, security
│   │   └── main.py        # FastAPI app entry
│   ├── requirements.txt
│   └── startup.bat
├── frontend/              # React + Vite frontend
│   ├── src/
│   │   ├── pages/         # Дэлгэцүүд
│   │   ├── components/    # UI компонентууд
│   │   ├── store/         # Zustand state
│   │   └── lib/           # api.ts, auth.ts
│   ├── certs/             # SSL certs (локал HTTPS)
│   ├── package.json
│   └── vite.config.ts
├── erkhet-automation/     # Erkhet automation (тусдаа систем)
│   ├── erkhet/            # auth.py, browser.py, reports.py
│   ├── utils/             # logger, messenger, notify
│   ├── main.py
│   ├── send_reports.py
│   ├── requirements.txt
│   └── .env.example
├── start.bat              # Backend + Frontend хамтад асаах
├── .gitignore
└── README.md
```

---

## Тусламж

- GitHub Issues: https://github.com/ez4puljin/Butenorgil/issues
- Хөгжүүлэгч: `ez4puljin`

---

## Лиценз

Дотоод хэрэглээнд зориулсан.
