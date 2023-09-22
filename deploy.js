const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Client } = require("ssh2");

// Load environment variables from .env file
dotenv.config();

// Configuration
const serverHost = process.env.SERVER_HOST; // Replace with your server's IP or hostname
const serverPort = parseInt(process.env.SERVER_PORT, 10); // SSH port (default is 22)
const serverUsername = process.env.SERVER_USERNAME;
const serverPassword = process.env.SERVER_PASSWORD; // Your server's password (or use SSH key)
const localPath = process.env.LOCAL_PATH; // Local path to your build files
const remotePath = process.env.REMOTE_PATH; // Destination directory on the server

const commands = [
  `cd ${remotePath}`,
  `yarn`,
  `node --experimental-modules -r ts-node/register -r tsconfig-paths/register ./node_modules/typeorm/cli.js migration:run -f ./ormconfig.json`,
  `rm -rf ./ormconfig.json ./migrations`,
  `pm2 restart api_v2 --update-env`,
];

// Create an SSH client
const ssh = new Client();

// Connect to the server
ssh
  .on("ready", () => {
    console.log("SSH connection established.");

    // Upload files
    ssh.sftp((err, sftp) => {
      if (err) throw err;

      const localFiles = fs.readdirSync(localPath);

      console.log("localFiles", localFiles);

      // ----------------------------------------
      function uploadFileOrDirectory(fileIndex) {
        if (fileIndex >= localFiles.length) {
          // All files uploaded, execute the PM2 restart command
          ssh.exec(commands.join(" && "), (err, stream) => {
            if (err) throw err;

            stream
              .on("data", (data) => {
                console.log("Command Output:", data.toString());
              })
              .on("close", (code, signal) => {
                console.log(`Command exited with code ${code}`);
                ssh.end();
              });
          });
          return;
        }

        const file = localFiles[fileIndex];
        const localFilePath = path.resolve(__dirname, localPath, file);
        const remoteFilePath = path.join(remotePath, file).replace(/\\/g, "/");
        console.log("remoteFilePath", remoteFilePath);

        const isDirectory = fs.statSync(localFilePath).isDirectory();
        console.log("isDirectory", isDirectory);

        if (isDirectory) {
          // If it's a directory, create the remote directory and upload its contents recursively
          sftp.mkdir(remoteFilePath, (err) => {
            const subLocalPath = path.resolve(__dirname, localPath, file);
            console.log("subLocalPath", subLocalPath);

            uploadDirectory(localFilePath, remoteFilePath, () => {
              uploadFileOrDirectory(fileIndex + 1);
            });
          });
        } else {
          // If it's a regular file, upload it
          const readStream = fs.createReadStream(localFilePath);
          const writeStream = sftp.createWriteStream(remoteFilePath);

          readStream.pipe(writeStream);

          writeStream.on("close", () => {
            console.log(`File "${file}" uploaded.`);
            // Upload the next file or directory
            uploadFileOrDirectory(fileIndex + 1);
          });
        }
      }

      // ------------------------------
      function uploadDirectory(localDirPath, remoteDirPath, callback) {
        const subLocalFiles = fs.readdirSync(localDirPath);
        let count = subLocalFiles.length;

        if (count === 0) {
          // No files or directories in this directory
          callback();
          return;
        }

        function checkUploadCompletion() {
          count--;
          if (count === 0) {
            callback();
          }
        }

        subLocalFiles.forEach((subFile) => {
          const subLocalPath = path.join(localDirPath, subFile);
          const subRemotePath = path
            .join(remoteDirPath, subFile)
            .replace(/\\/g, "/");
          if (fs.statSync(subLocalPath).isDirectory()) {
            sftp.mkdir(subRemotePath, (err) => {
              if (err) throw err;
              uploadDirectory(
                subLocalPath,
                subRemotePath,
                checkUploadCompletion
              );
            });
          } else {
            const readStream = fs.createReadStream(subLocalPath);
            const writeStream = sftp.createWriteStream(subRemotePath);

            readStream.pipe(writeStream);

            writeStream.on("close", () => {
              console.log(`File "${subFile}" uploaded.`);
              checkUploadCompletion();
            });
          }
        });
      }

      // Start uploading the first file
      uploadFileOrDirectory(0);
    });
  })
  .connect({
    host: serverHost,
    port: serverPort,
    username: serverUsername,
    password: serverPassword,
    // privateKey: 'path/to/private/key', // Use this for SSH key authentication
  });

// Handle errors
ssh.on("error", (err) => {
  console.error("SSH connection error:", err.message);
  ssh.end();
});
