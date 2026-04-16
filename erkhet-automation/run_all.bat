@echo off
cd /d "%~dp0"
set PYTHON=venv\Scripts\python.exe

echo [1/6] inventory_cost
set REPORT_TYPE=inventory_cost
%PYTHON% main.py

echo [2/6] inventory_items
set REPORT_TYPE=inventory_items
%PYTHON% main.py

echo [3/6] milko_movement
set REPORT_TYPE=milko_movement
%PYTHON% main.py

echo [4/6] milko_sale
set REPORT_TYPE=milko_sale
%PYTHON% main.py

echo [5/6] altanjoluu_movement
set REPORT_TYPE=altanjoluu_movement
%PYTHON% main.py

echo [6/6] altanjoluu_sale
set REPORT_TYPE=altanjoluu_sale
%PYTHON% main.py

echo.
echo [7/7] Messenger-eer tailanguud ilgeej baina...
%PYTHON% send_reports.py

echo Done! Check downloads folder and Messenger groups.
pause
