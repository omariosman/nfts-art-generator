const fs = require("fs");
const os = require("os");
const https = require('https');
const Jimp = require("jimp");
const path = require("path");
const pinataSDK = require('@pinata/sdk');
const { marshall } = require("@aws-sdk/util-dynamodb");
const axios = require("axios");
require("dotenv").config();
const { ERR, ENDPOINTS, PROJECT, DIR, BUCKET, DB_TABLES } = require("../config/constants");
const { writeFileToS3, readFileFromS3, readDirectoryFromS3, deleteFileFromS3 } = require("../services/s3");
const Dynamo = require('../common/Dynamo');


let dirToPath = {};
let metadata = [];
let attributes = [];
let hash = [];
let decodedHash = [];
const Exists = new Set();
const pinata = new pinataSDK({ pinataJWTKey: process.env.PINATA_JWT });

const getCurrentTime = () => {
    let now = new Date();
    let year = now.getFullYear();
    let month = (now.getMonth() + 1).toString().padStart(2, '0');
    let day = now.getDate().toString().padStart(2, '0');
    let hours = now.getHours().toString().padStart(2, '0');
    let minutes = now.getMinutes().toString().padStart(2, '0');
    let seconds = now.getSeconds().toString().padStart(2, '0');
    
    let currentDateTime = year + '_' + month + '_' + day + '_' + hours + '_' + minutes + '_' + seconds;
    return currentDateTime;
}

const getContentType = (event) => {
    const contentType = event.headers['content-type'];
    if (!contentType) {
        return event.headers['Content-Type'];
    }
    return contentType;
};

const setupSystem = async () => {
    try {  
      let directories = ["ZIPFILE", "EXTRACTED", "JSON", "OUTPUT"];
      await createDirs(directories);
    } catch(e) {
      throw new Error(`${ERR.SYSTEM_SETUP} | ${e.message}`);
    }
};


const createDirs = async (directories) => {
    for (let i = 0; i < directories.length; i++) {
        let currentDateTime = getCurrentTime();
        let dir = path.join(os.tmpdir(), `${directories[i]}_${currentDateTime}`);
        await createDirAsync(dir, directories[i]);
    }
}

const setupSystemS3 = async (userAddress, uuid) => {
    try {  
      let directories = ["JSONS3", "OUTPUTS3"];
      await createDirsS3(userAddress, directories, uuid);
    } catch(e) {
      throw new Error(`${ERR.SYSTEM_SETUP} | ${e.message}`);
    }
};

const createDirsS3 = async (userAddress, directories, uuid) => {
    for (let i = 0; i < directories.length; i++) {
        const dirTail = `${PROJECT.HORUS}_${userAddress}_${uuid}_${directories[i]}`
        let dir = path.join(
            os.tmpdir(),
            dirTail
        );
        await createDirAsync(dir, directories[i]);
    }
}

const createDirAsync = (dirPath, name) => {
    return new Promise((resolve, reject) => {
        fs.mkdir(dirPath, (err) => {
            if (err) reject(err);
            dirToPath[name] = dirPath;
            resolve();
        })
    })
}

const pinataUploadFileWithRetry = async(filePath, timeout = 10000) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timed out')), timeout);
    });
    const readStream = fs.createReadStream(filePath);
    let pinataResponse = pinata.pinFileToIPFS(readStream);
    try {
      const response = await Promise.race([
        pinataResponse,
        timeoutPromise
      ]);      
      console.log(`response: ${JSON.stringify(response, null, 2)}`)
      return response.IpfsHash;
    } catch (error) {
      console.error(`pinata upload failed: ${JSON.stringify(error)}`);
      // Retry 
      return pinataUploadFileWithRetry(filePath, timeout);
    }
}


const IPFS_BASE = "https://horus.mypinata.cloud/ipfs";

const cleanName = (_str) => {
    let name = _str.slice(0, -4);
    return name;
};
  
const getElements = (dirPath) => {
return new Promise((resolve, reject) => {
    fs.readdir(dirPath, (err, files) => {
        if (err) {
            reject(err);
            return;
        }
        const objects = files.map((element, index) => {
            return {
                id: index,
                name: cleanName(element),
                fileName: element
            };
        });
        resolve(objects); 
    });
    });
};
  

const layersSetup = async (parentFile, layersInfo, format) => {
    try {
        let layers = [];
        for (let i = 0; i < layersInfo.length; i++) {
            const layer = {
                id: i,
                name: layersInfo[i].name,
                location: `${dirToPath["EXTRACTED"]}/${parentFile}/${layersInfo[i].name}/`,
                elements: await getElements(`${dirToPath["EXTRACTED"]}/${parentFile}/${layersInfo[i].name}`),
                size: { width: format.width, height: format.height },
                number: layersInfo[i].number,
                probs: layersInfo[i].probs
            }
            layers.push(layer);
        }
        return layers;
    } catch(e) {
        console.log(e);
        throw new Error(`${ERR.LAYERS_SETUP} | ${e}`);
    }
};


const addMetadata = async (_edition) => {
    let dateTime = getCurrentTime();
    let dir = path.join(dirToPath["OUTPUT"], `${_edition}.jpg`);
    let url = await pinataUploadFileWithRetry(dir);
    console.log(`url" ${url}`);
    let tempMetadata = {
      hash: hash.join(""),
      tokenId: _edition,
      date: dateTime,
      attributes: attributes,
      image: `${IPFS_BASE}/${url}`
    };
    const jsonData = JSON.stringify(tempMetadata, null, 2);
    const filename = path.join(dirToPath["JSON"], `${_edition}`);
    metadata.push(tempMetadata);
    fs.writeFileSync(filename, jsonData);
    attributes = [];
    hash = [];
    decodedHash = [];
};
  


const addAttributes = (_element, _layer) => {
    let tempAttr = {
      id: _element.id,
      trait_type: _layer.name,
      value: _element.name,
    };
    attributes.push(tempAttr);
    hash.push(_layer.id);
    hash.push(_element.id);
    decodedHash.push({ [_layer.id]: _element.id });
};
  

const pickElementWithProbs = (probsArr) => {
    const random = Math.random();
    let cumulativeProbability = 0;
    for (let i = 0; i < probsArr.length; i++) {
        cumulativeProbability += probsArr[i];
        if (random < cumulativeProbability) {
            return i;
        }
    }
    return 0;
}

const drawLayer = async (layer, canvas) => {
    const selected = pickElementWithProbs(layer.probs);
    const imageSrc = `${layer.location}${layer.elements[selected].fileName}`;
    console.log(`image src: ${imageSrc}`);
    addAttributes(layer.elements[selected], layer);
  
    // Load and draw image on the canvas
    const img = await Jimp.read(imageSrc);
  
    canvas.composite(img, 0, 0);
}
  

const stackImageLayers = async (edition, layers, format) => {
    try {
        for (let j = 0; j < edition; j++){
            const canvasWidth = format.width;
            const canvasHeight = format.height;
            const canvas = await Jimp.create(canvasWidth, canvasHeight);
            let noUnique = 0;
            for (let i = 0; i < layers.length; i++) {
                console.log("draw layer", i);
                await drawLayer(layers[i], canvas);
            }
            let key = hash.toString();
            if (Exists.has(key)){
                noUnique++;
                if (noUnique > edition) break;
                j--;
            } else {
                await canvas.writeAsync(path.join(dirToPath["OUTPUT"], `${j}.jpg`));
                Exists.add(key);
                console.log(`Composite image for edition ${j} saved.`);
                await addMetadata(j);
            }
        }
        return metadata;
    } catch(e) {
        console.log(e);
        throw new Error(`${ERR.STACK_IMAGES} | ${e}`);
    }
}
  

const pinataUploadDirWithRetry = async(src, timeout = 15000) => {
    try {
        const response = await pinata.pinFromFS(src);
        const url = `${IPFS_BASE}/${response.IpfsHash}`;
        return url;
    } catch (error) {
        console.error(`pinata upload failed: ${JSON.stringify(error)}`);
        // Retry 
        return pinataUploadDirWithRetry(src, timeout);
    }
}

const queryAiBot = async(content, type) => {
    const endpoint = ENDPOINTS.ASK_AI;

    const data = { content, type };
    try {
      const response = await axios.post(endpoint, data, {
        headers: {
          "Content-Type": "application/json",
        },
      });

      return response;
    } catch (error) {
      console.error(`${ERR.AI_BOT_FAILED} | ${error}`);
      throw new Error(`${ERR.AI_BOT_FAILED} | ${error}`);
    }
}

let imageAttributes = [];

const getAIPrompt = (layers, mainCharacter) => {
    let prompt = `Generate an image of ${mainCharacter} that has `;
    imageAttributes = [];
    layers.forEach((layer, index) => {
        const optionIndex = pickElementWithProbs(layer.probs);
        const selectedOption = layer.options[optionIndex];
        prompt += `${selectedOption} ${layer.name}`;

        let traitDetails = {
            trait_type: layer.name,
            value: selectedOption
        }
        imageAttributes.push(traitDetails);

        if (index != layers.length -1) 
            prompt += ` and `;
    });

    return prompt;
}

const generateImages = async (mainCharacter, layers, nftsCount) => {
    for (let i = 0; i < nftsCount; i++) {
        let jsonMetadata = {};
        const prompt = getAIPrompt(layers, mainCharacter);
        console.log(`prompt: ${prompt}`);
    
        // call AI API
        let res;
        try {
            res = await queryAiBot(prompt, "image");
        } catch(e) {
            throw new Error(e);
        }
        let base64Data = res.data.generated_image;
        base64Data = base64Data.replace(/^data:image\/png;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");

        const filePath = `${dirToPath["OUTPUT"]}/${i}.png`;
        fs.writeFileSync(filePath, buffer);

        //upload file to pinata
        const imageIpfsHash = await pinataUploadFileWithRetry(filePath);
        const imageUri = `${IPFS_BASE}/${imageIpfsHash}`;
        jsonMetadata = { image: imageUri, attributes: imageAttributes };
        const filename = path.join(dirToPath["JSON"], `${i}`);
        const jsonData = JSON.stringify(jsonMetadata, null, 2);
        fs.writeFileSync(filename, jsonData);

        console.log(`jsonMetadata: ${JSON.stringify(jsonMetadata, null, 2)}`);
    }
}


const updateNftStatus = async(uuid, currentIndex, totalNfts) => {
    try {
        console.log(`current index: ${currentIndex}`);
        const status = currentIndex / totalNfts * 100;
        console.log(`current status: ${status}`);

        const table = DB_TABLES.GENERATIVE_NFTS_STATUS;

        const Key = {
            id: uuid
        };
        
        const marshallalledKey = marshall(Key);
        const updateExpression = "SET #status = :val";
        const expressionAttributeNames = { 
            "#status" : "status",
        }
        const expressionAttributeValues = {":val": status};
        const marshalledExpressionAttributeValues = marshall(expressionAttributeValues);
    
        const updatedItem = await Dynamo.updateItem(
            table,
            marshallalledKey,
            updateExpression,
            expressionAttributeNames,
            marshalledExpressionAttributeValues
        );
        console.log(`updatedItem: ${JSON.stringify(updatedItem, null, 2)}`);
        console.log("update status done");
    } catch(e) {
        console.log(`${ERR.DYNAMODB_OPERATION_FAILED} | ${e}`);
        throw new Error(e);
    }
}

const generateImagesS3 = async (id, mainCharacter, layers, nftsCount) => {
    for (let i = 0; i < nftsCount; i++) {
        const prompt = getAIPrompt(layers, mainCharacter);
        console.log(`prompt: ${prompt}`);
    
        let res;
        try {
            res = await queryAiBot(prompt, "image");
        } catch(e) {
            throw new Error(e);
        }
        let base64Data = res.data.generated_image;
        const imageBuffer = getImageBuffer(base64Data);

        const filePath = `${dirToPath["OUTPUTS3"]}/${i}.png`;
        saveImage(filePath, imageBuffer);
        saveUri(i, prompt);
        await updateNftStatus(id, i + 1, nftsCount);
    }
}

const saveImage = (filePath, imageBuffer) => {
    try {
        fs.writeFileSync(filePath, imageBuffer);
    } catch(e) {
        console.log(`saveImage failed with: ${e}`);
        throw new Error(e);
    }
}

const getImageBuffer = (base64Data) => {
    try {
        base64Data = base64Data.replace(/^data:image\/png;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        return buffer;
    } catch(e) {
        console.log(`getImageBuffer failed with: ${e}`);
        throw new Error(e);
    }
}

const saveUri = (index, prompt) => {
    try {
        const jsonMetadata = { attributes: imageAttributes, prompt };
        const filename = path.join(dirToPath["JSONS3"], `${index}`);
        const jsonData = JSON.stringify(jsonMetadata, null, 2);
        fs.writeFileSync(filename, jsonData);
    } catch(e) {
        console.log(`saveUri failed with: ${e}`);
        throw new Error(e);
    }
}

const replaceImage = async(userAddress, uniqueKey, imageIndex, base64Data) => {
    const newFilePath = `/tmp/${PROJECT.HORUS}_${userAddress}_${uniqueKey}_IMAGES_${imageIndex}.png`;
    const imageBuffer = getImageBuffer(base64Data);
    saveImage(newFilePath, imageBuffer);

    // delete old image
    const filePath = `${PROJECT.HORUS}/${userAddress}/${uniqueKey}/IMAGES/${imageIndex}.png`;
    await deleteFileFromS3(filePath, BUCKET.HORUS_GENERAIVE);

    // write new img
    const fileContent = fs.readFileSync(newFilePath);
    await writeFileToS3(BUCKET.HORUS_GENERAIVE, filePath, fileContent);
}

const getImagePrompt = async(userAddress, uniqueKey, imageIndex) => {
    const filePath = `${PROJECT.HORUS}/${userAddress}/${uniqueKey}/URIS/${imageIndex}`;
    const fileContent = await readFileFromS3(filePath, BUCKET.HORUS_GENERAIVE);
    if (fileContent.prompt) return fileContent.prompt;
        else return null;
}

const downloadImage = (url, destination) => {
    return new Promise((resolve, reject) => {
        https.get(url, response => {
            const fileStream = fs.createWriteStream(destination);
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close(resolve(true));
            });
            fileStream.on('error', error => {
                fs.unlink(destination, () => {
                    reject(error);
                });
            });
        }).on('error', error => {
            reject(error);
        });
    });
};

const downloadAllImages = async (urls, destination) => {
    try {
        if (!fs.existsSync(destination)) {
            fs.mkdirSync(destination, { recursive: true });
        }

        for (let i = 0; i < urls.length; i++) {
            const filename = path.basename(urls[i]);
            const dest = path.join(destination, filename);
            console.log(`Downloading ${urls[i]} to ${dest}`);
            try {
                await downloadImage(urls[i], dest);
                console.log(`Downloaded ${urls[i]} to ${dest}`);
            } catch (error) {
                console.error(`Failed to download ${urls[i]}: ${error.message}`);
            }
        }
    } catch(e) {
        console.log(`downloadAllImages failed with: ${e}`);
        throw new Error(e);
    }
};

const addImgUriToMetadata = async(filesCount, userAddress, id, baseUri, tempDir) => {
    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        for (let i = 0; i < filesCount; i++) {
            const filePath = `${PROJECT.HORUS}/${userAddress}/${id}/URIS/${i}`;
            const fileContent = await readFileFromS3(filePath, BUCKET.HORUS_GENERAIVE);
            fileContent.image = `${baseUri}/${i}.png`;
            const destination = `${tempDir}/${i}`;
            saveImage(destination, JSON.stringify(fileContent));
        }
    } catch(e) {
        console.log(`addImgUriToMetadata failed with: ${e}`);
        throw new Error(e);
    }
}

const getImagesBaseUri = async(userAddress, id) => {
    const imagesPath = `${PROJECT.HORUS}/${userAddress}/${id}/IMAGES`;
    const imagesTempDir = path.join(os.tmpdir(), userAddress, id, "IMAGES");
    const imagesUrls = await readDirectoryFromS3(imagesPath, BUCKET.HORUS_GENERAIVE);
    await downloadAllImages(imagesUrls, imagesTempDir);
    const imagesBaseUri = await pinataUploadDirWithRetry(imagesTempDir);
    console.log(`imagesBaseUri: ${imagesBaseUri}`);

    return [imagesUrls.length, imagesBaseUri];
}

const getMetadataBaseUri = async(nftsCount, userAddress, id, baseUri) => {
    const UrisTempDir = path.join(os.tmpdir(), userAddress, id, "URIS");
    await addImgUriToMetadata(nftsCount, userAddress, id, baseUri, UrisTempDir);

    const metadataBaseUri = await pinataUploadDirWithRetry(UrisTempDir);
    console.log(`metadataBaseUri: ${metadataBaseUri}`);

    return metadataBaseUri;
}


