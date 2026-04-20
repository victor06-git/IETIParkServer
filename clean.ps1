# Script de neteja per PowerShell

function Clean-Project {
    param (
        [string]$ProjectPath
    )

    Write-Host "Netejant $ProjectPath..." -ForegroundColor Cyan

    # Canviar al directori del projecte
    Push-Location $ProjectPath

    try {
        # Eliminar node_modules
        if (Test-Path -Path "node_modules") {
            Write-Host "Eliminant node_modules..." -ForegroundColor Yellow
            Remove-Item -Path "node_modules" -Recurse -Force -ErrorAction SilentlyContinue
        }

        # Eliminar directori de coverage
        if (Test-Path -Path "coverage") {
            Write-Host "Eliminant directori de coverage..." -ForegroundColor Yellow
            Remove-Item -Path "coverage" -Recurse -Force -ErrorAction SilentlyContinue
        }

        # Netejar caché de npm
        Write-Host "Netejant caché de npm..." -ForegroundColor Yellow
        npm cache clean --force
    }
    catch {
        Write-Host "S'ha produït un error en netejar $ProjectPath" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    finally {
        # Tornar al directori original
        Pop-Location
    }
}

# Configurar colors i missatges
$Host.UI.RawUI.ForegroundColor = "White"

# Missatge de benvinguda
Write-Host "=== Script de Neteja de Projectes ===" -ForegroundColor Green

# Netejar projectes
Clean-Project -ProjectPath "exemple-mongodb"

# Missatge de conclusió
Write-Host "`nNeteja completada." -ForegroundColor Green
