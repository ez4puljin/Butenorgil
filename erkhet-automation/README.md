# Эрхэт Үлдэгдлийн Тайлан — Автоматжуулалт

Эрхэт нягтлан бодох бүртгэлийн системээс **Бараа материалын үлдэгдлийн тайлан** (өртгөөр) автоматаар татаж Excel файлаар хадгалдаг програм.

Python + Playwright ашиглан browser-г автоматаар удирдаж, хүний оролцоогүйгээр тайлан татна.

---

## Юу хийдэг вэ?

1. Эрхэт системд автоматаар **нэвтэрнэ** (login)
2. **Тайлан** цэс рүү очно (`reports/list`)
3. **Бараа материал /Өртгөөр/** тайланг сонгоно
4. Modal форм дотор:
   - **Огноо** оруулна (өчигдөр, өнөөдөр, энэ сар гэх мэт)
   - **Байршил** сонгоно (01, 02, 10, 11, 12 гэх мэт)
   - **Данс** сонгоно (150101 гэх мэт)
5. Тайлан **үүсгэнэ** (POST submit)
6. **Excel** товч дарж `.xls` файлаар татна
7. `downloads/` хавтаст хадгална

---

## Шаардлага

- **Python 3.11 эсвэл 3.12** (Python 3.14 дэмжихгүй — доорх тайлбарыг үз)
- **Windows 10/11** (Linux, Mac дээр ч ажиллана)
- Эрхэт системийн нэвтрэх эрх (имэйл + нууц үг)

---

## Суулгах заавар

### 1. Repo клон хийх

```bash
git clone https://github.com/ez4puljin/automation-butenorgil.git
cd automation-butenorgil
```

### 2. Python виртуал орчин үүсгэх

> **Анхааруулга:** Python 3.14 ашиглаж байвал `greenlet` пакет суухгүй тул алдаа гарна.
> Python 3.11 эсвэл 3.12 суулгасан байх шаардлагатай.
>
> PowerShell-д суулгах:
> ```powershell
> winget install Python.Python.3.11
> ```

```cmd
py -3.11 -m venv venv
```

Идэвхжүүлэх:

```bash
# Windows:
venv\Scripts\activate

# Mac/Linux:
source venv/bin/activate
```

### 3. Шаардлагатай сангууд суулгах

```bash
pip install -r requirements.txt
```

### 4. Playwright browser суулгах

```bash
playwright install chromium
```

Энэ команд Chromium browser-г автоматаар татаж суулгана.

### 5. `.env` тохиргоо хийх

`.env` файлд өөрийн Эрхэт нэвтрэх мэдээллийг оруулна:

```env
# ===== Эрхэт тохиргоо =====
ERKHET_URL=https://erkhet.bto.mn
ERKHET_USERNAME=таны_имэйл@gmail.com
ERKHET_PASSWORD=таны_нууц_үг
ERKHET_COMPANY_ID=9514593312

# ===== Тайлан тохиргоо =====
REPORT_TYPE=inventory_cost
REPORT_PERIOD=yesterday

# ===== Байршил, данс =====
REPORT_LOCATIONS=01,02,10,11,12
REPORT_ACCOUNT=150101

# ===== Татсан файл хадгалах =====
DOWNLOAD_DIR=./downloads
```

---

## Ашиглах заавар

### Нэг удаа ажиллуулах

```bash
# Headless горим (browser харагдахгүй, хурдан):
python main.py

# Headful горим (browser харагдана, debug хийхэд):
python main.py --visible

# Удаан горим (алхам бүрийг харах):
python main.py --visible --slow
```

### Өдөр бүр автомат ажиллуулах

```bash
python scheduler.py
```

Энэ нь `.env` дотор тохируулсан цагт (`SCHEDULE_HOUR`, `SCHEDULE_MINUTE`) өдөр бүр автомат ажиллана.

---

## `.env` тохиргооны тайлбар

| Тохиргоо | Тайлбар | Жишээ |
|---|---|---|
| `ERKHET_URL` | Эрхэт системийн URL | `https://erkhet.bto.mn` |
| `ERKHET_USERNAME` | Нэвтрэх имэйл | `user@gmail.com` |
| `ERKHET_PASSWORD` | Нууц үг | `1234` |
| `ERKHET_COMPANY_ID` | Компанийн ID (URL-д харагддаг) | `9514593312` |
| `REPORT_TYPE` | Тайлангийн төрөл (доорх жагсаалтаас) | `inventory_cost` |
| `REPORT_PERIOD` | Хугацаа | `yesterday` |
| `REPORT_LOCATIONS` | Байршлын кодууд (таслалаар) | `01,02,10,11,12` |
| `REPORT_ACCOUNT` | Дансны код | `150101` |
| `DOWNLOAD_DIR` | Файл хадгалах хавтас | `./downloads` |
| `SCHEDULE_HOUR` | Автомат ажиллах цаг | `8` |
| `SCHEDULE_MINUTE` | Автомат ажиллах минут | `0` |
| `TELEGRAM_BOT_TOKEN` | Telegram мэдэгдэл (заавал биш) | |
| `TELEGRAM_CHAT_ID` | Telegram чат ID (заавал биш) | |

### `REPORT_TYPE` утгууд

| Утга | Тайлан |
|---|---|
| `inventory_cost` | Үлдэгдлийн тайлан (Бараа материал /Өртгөөр/) |
| `main_journal` | Ерөнхий журнал |
| `fund` | Мөнгөн хөрөнгө |
| `debt` | Авлага өглөг |
| `sale_item` | Борлуулалт /Бараагаар/ |
| `sale_cost` | Борлуулалт /Өртгөөр/ |
| `inventory_daily` | Бараа материал /Баримтаар/ |
| `inventory_census` | Бараа материал тооллого |
| `fixed_asset` | Үндсэн хөрөнгө |
| `debt_finish` | Тооцоо хаагдах төлөв |
| `inventory_remainder` | Барааны хязгаарт үлдэгдэл |
| `inventory_price` | Бараа материал /Үнээр/ |
| `inventory_shipper` | Бараа нийлүүлэлтийн тооцоо |
| `inventory_profit` | Барааны ашгийн тайлан |
| `sale_cost_period` | Борлуулалт /Өртгөөр/ - Үе шат |
| `subsys` | Дэд системийн тайлан |
| `balance` | Баланс |
| `result` | Үр дүнгийн тайлан |

### `REPORT_PERIOD` утгууд

| Утга | Тайлбар |
|---|---|
| `today` | Өнөөдөр |
| `yesterday` | Өчигдөр |
| `this_month` | Энэ сарын 1-ээс өнөөдөр хүртэл |
| `last_month` | Өмнөх сар бүтэн |

---

## Файлын бүтэц

```
automation-butenorgil/
├── main.py              # Гол ажиллуулах файл
├── config.py            # Тохиргоо (.env уншдаг)
├── scheduler.py         # Өдөр бүр автомат ажиллуулах
├── .env                 # Тохиргоо (имэйл, нууц үг, тайлан)
├── .env.example         # Тохиргооны загвар
├── requirements.txt     # Python сангууд
├── erkhet/
│   ├── auth.py          # Нэвтрэх (login)
│   ├── browser.py       # Browser удирдлага (Playwright)
│   └── reports.py       # Тайлан татах логик
├── utils/
│   ├── logger.py        # Лог бичих
│   └── notify.py        # Telegram мэдэгдэл
├── downloads/           # Татсан Excel тайлангууд
├── screenshots/         # Алдааны screenshot-ууд
└── logs/                # Лог файлууд (огноогоор)
```

---

## Алдаа гарвал

1. `screenshots/` хавтаст алдааны screenshot хадгалагдана — эхлээд тэрийг шалга
2. `logs/` хавтаст тухайн өдрийн лог файл байна — дэлгэрэнгүй алдааг харна
3. `--visible` горимоор ажиллуулж browser дээр юу болж байгааг хар:
   ```bash
   python main.py --visible
   ```
4. Нууц үг, имэйл зөв эсэхийг `.env` файлаас шалга

### `greenlet` суухгүй байвал (Python хувилбарын алдаа)

`pip install` хийхэд дараах алдаа гарвал Python 3.14 ашиглаж байна гэсэн үг:

```
error C2027: use of undefined type '_PyInterpreterFrame'
ERROR: Failed building wheel for greenlet
```

**Шийдэл — Python 3.11 суулгах:**

```powershell
# PowerShell-д ажиллуулах:
winget install Python.Python.3.11
```

Суусны дараа шинэ venv үүсгэх:

```cmd
py -3.11 -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```
