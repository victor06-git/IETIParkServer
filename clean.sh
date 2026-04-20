#!/bin/bash

# Function to clean a project directory
clean_project() {
    local project_dir=$1
    echo "Netejant $project_dir..."
    
    cd "$project_dir" || exit

    # Eliminar node_modules
    if [ -d "node_modules" ]; then
        echo "Eliminant node_modules..."
        rm -rf node_modules
    fi

    # Eliminar directori de coverage
    if [ -d "coverage" ]; then
        echo "Eliminant directori de coverage..."
        rm -rf coverage
    fi

    # Netejar caché de npm
    npm cache clean --force

    cd - > /dev/null
}

# Netejar projectes
clean_project "exemple-mongodb"

echo "Neteja completada."
