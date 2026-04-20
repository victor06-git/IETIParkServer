<div style="display: flex; width: 100%;">
    <div style="flex: 1; padding: 0px;">
        <p>© Albert Palacios Jiménez, 2024</p>
    </div>
    <div style="flex: 1; padding: 0px; text-align: right;">
        <img src="./assets/ieti.png" height="32" alt="Logo de IETI" style="max-height: 32px;">
    </div>
</div>
<br/>

# Servidor de l'insitut

```bash
#Pas 1 Crear clau pública RSA (ha de ser d'aquest tipus)
ssh-keygen -t rsa


#Assegurar que els permissos són 
chmod 600 $HOME/.ssh/id_rsa

#Usuari proxmox = correu iesesteveterradas sense .25cf@iesestevterradas.cat

#Pas2 Entrar al portal de claus https://kamehouse.ieti.site amb el compte "@iesestevterradas.cat"
#(el domini és .SITE!)
#Crear una nova clau pública amb la clau que s'obte de la comanda local:
cat $HOME/.ssh/id_rsa.pub

#Pas3 Configurar arxiu proxmox/config.env
DEFAULT_USER="usuariesteveterradas"
DEFAULT_RSA_PATH="$HOME/.ssh/id_rsa"
DEFAULT_SERVER_PORT="3000"

#Connectar amb
./proxmoxConnect.sh
```

<center><img src="./assets/logo-nodejs.png" style="max-width: 90%; max-height: 200px;" alt="">
<br/></center>
<br/>

# NodeJS

**[NodeJS](https://nodejs.org/en)** és executor de codi *JavasScript*.

# Express

**[Express](https://expressjs.com/)** és un framework que permet crear servidors web i APIs sobre **Node.js**

## Instal·lar NodeJS

A Linux:
```bash
sudo apt install npm zip unzip iptables-persistent
sudo npm cache clean -f
sudo npm install -g n
sudo n latest
sudo npm install -g pm2
```

A MacOS:
```bash
sudo brew install node
sudo npm cache clean -f
sudo npm install -g n
sudo n latest
sudo npm install -g pm2
```

## Servidor web (local)

El servidor web està a la carpeta "server"

Per fer anar el servidor en mode **"desenvolupament"**:
```bash
node --run dev
```
Això permet que el servidor es reinicii quan fem canvis al codi.

Per fer anar el servidor en mode **"producció"**:
```bash
pm2 start ./server/app.js --name "app"
```
Això permet que si el servidor es "penja" es reinicia per seguir funcionant.

A producció (Proxmox) tindrem comandes per llistar o aturar el servidor:
```bash
pm2 list
pm2 delete app
```

Un cop el servidor funciona es pot accedir a la pàgina local:
```text
http://0.0.0.0:3000
```

La pàgina està ubicada a la carpeta:
```text
Proxmox/nodejs_web/public
```

# Proxmox

**Proxmox** és un sistema de servidor que permet tenir una vàris contenedors Linux funcionant com a servidors.

Amb el compte de l'insitut tens accés a un servidor *Proxmox* personal del centre. Per connectar-hi:

- Configura l'arxiu **./proxmox/config.env"** amb el teu usuari i la ubicació de la clau per accedir al servei.

- Connecta't al **Proxmox** remot
```bash
bash ./proxmoxConnect.sh
```

## Instal·lar NodeJS al Proxmox de l'institut

```bash
# Al terminal local, connecta't al proxmox remot
bash ./proxmoxConnect.sh
# Escriu la contrasenya (si en tens)

# Al terminal remot del proxmox:

# Desinstal·la Apache si està instal·lat
sudo systemctl stop apache2
sudo apt purge apache2 apache2-bin apache2-data apache2-utils
sudo apt autoremove --purge
sudo rm -rf /etc/apache2
sudo rm -rf /var/www
sudo rm -rf /var/log/apache2
sudo rm -rf /var/lib/apache2

# Instal·la NodeJS a la última versió
sudo apt install npm zip unzip iptables-persistent
sudo npm cache clean -f
sudo npm install -g n
sudo n latest
sudo npm install -g pm2
exit
```

## Redirecció del port 80

Cal que el servidor remot redireccioni les peticions del port 80 al port 3000 (del NodeJS), per respondre a les peticions web.

```bash
./proxmoxSetupRedirect80.sh
```

## Enviar la pàgina web al Proxmox

Aquest script empaqueta la pàgina web i l'envia al Proxmox

```bash
./proxmoxDeploy.sh
```

La pàgina queda publicada a:

[https://usuari.ieti.site](https://usuari.ieti.site)

## Enviar arxius al Proxmox

L'script **'proxmoxSendFile.sh'** permet enviar arxius al Proxmox:

Exemple:

```bash
./proxmoxSendFile.sh $HOME/Baixades/nomArxiu.txt
```

L'arxiu queda a l'arrel del servidor.

# MySQL al Proxmox

Al servidor remot "Proxmox" es pot instal·lar un MySQL, per accedir-hi caldrà fer un "túnel" entre el vostre ordinador i el servidor.

## Instal·lar MySQL al servidor remot

Des de la consola local, connectar amb el servidor:

```bash
./proxmoxConnect.sh
```

Un cop connectats, des de la consola remota instal·lar MySQL. Les següents comandes poden anar lentes, no talleu la connexió i llegiu bé els missatges d'error en cas que n'hi hagin:

```bash
sudo apt update
sudo apt install mysql-server
sudo systemctl status mysql

# Connectar a la base de dades des del propi servidor remot i crear l'usuari 'super':

sudo mysql
CREATE USER 'super'@'localhost' IDENTIFIED WITH caching_sha2_password BY '1234';
GRANT ALL PRIVILEGES ON *.* TO 'super'@'localhost' WITH GRANT OPTION;
FLUSH PRIVILEGES;
quit
```

## Connectar a la base de dades MySQL del servidor remot (túnel)

Des del vostre ordinador, primer cal configurar el **"túnel"** entre el vostre ordinador i el servidor remot, executa la següent comanda per **obrir el túnel**:

```bash
./proxmoxTunelStart.sh
```

Executa la següent comanda per **saber si el túnel està obert**:

```bash
./proxmoxTunelStatus.sh
```

Executa la següent comanda per **aturar el túnel**:

```bash
./proxmoxTunelStop.sh
```

Amb el túnel funcionant, podeu connectar-vos a la base de dades remota, però ho heu de fer a la ip local **127.0.0.1** i port **3306**!

```bash
mysql -h 127.0.0.1 -P 3307 -u super -p
```

Demana el codi (abans hem posat 1234)

```text
1234
```

Des de la consola 'MySQL' remota:
```text
SHOW DATABASES;
quit
```

Si la comanda anterior ja us funciona, podeu configurar **"MySQLWorkbench"** (o la eina gràfica que volgueu)

```text
Host: 127.0.0.1
Port: 2207
User: super
Password: 1234
```

Evidentment, **només funcionarà amb el tunel activat**

## Clonar una base de dades local cap al servidor remot

Si teniu una base de dades al MySQL local i la voleu enviar al servidor remot

**Nota:** *canvieu 'nom_db' pel nom de la vostre base de dades*

1 - Obrir el túnel

2 - Crear una còpia de la base de dades local cap a l'arxiu 'dump.sql'

```bash
mysqldump -h 127.0.0.1 -P 3306 -u super -p nom_db > dump.sql
```

3 - Crear la base de dades al servidor remot

```bash
mysql -h 127.0.0.1 -P 3307 -u super -p -e "CREATE DATABASE IF NOT EXISTS nom_db;"
```

4 - Enviar les dades de l'arxiu 'dump.sql' a la base de dades remota

```bash
mysql -h 127.0.0.1 -P 3307 -u super -p nom_db < dump.sql
```

5 - Connectar a la base de dades remota, directament a la base de dades creada/clonada 'nom_db'

```bash
mysql -h 127.0.0.1 -P 3307 -u super -p nom_db
```

Demana el codi (abans hem posat 1234)

```text
1234
```

6 - Des de la consola MySQL remota, comprovar que hi ha les dades/taules esperades al servidor MySQL remot.

```sql
SHOW TABLES;
quit
```