const { layersOrder, format, edition } = require("./config.js");
let layersDir = "./layers";
let buildDir = "./build";
const fs = require("fs");

// canvas

const { createCanvas, loadImage } = require("canvas");

const canvas = createCanvas(format.width, format.height);

const ctx = canvas.getContext("2d");
// Global variables
// let metadata = [];
// let attributes = [];
// let hash = [];
// let decodedHash = [];
// const Exists = new Map();
// 
const cleanName = (str, itr) => {
    return str.slice(0, itr);
}

const createDir = () => {
    if (!fs.existsSync("./build")) {
        fs.mkdirSync("./build", () => {});
    }
}

const getElements = (layerPath) => {
    return fs
        .readdirSync(layerPath)
        .map((i, index) => {
            return {
                id: index + 1,
                name: cleanName(i, -4),
                fileName: i
            }
        }) 
}

const layersSetup = (layersOrder) => {
    const layers = layersOrder.map((layer, index) => ({
        id: index + 1,
        name: layer.name,
        location : `${layersDir}/${layer.name}`,
        order: layer.order,
        size: { width: format.width, height: format.height },
        elements : getElements(`${layersDir}/${layer.name}`)
    }));

    return layers;
}

  const drawLayer = async (_layer, _currentEdition) => {
    const selected = Math.floor(Math.random() * _layer.elements.length);
    let element = _layer.elements[selected];
    let elementPath = `${_layer.location}/${element.fileName}`;
    const image = await loadImage(elementPath);
    ctx.drawImage(
      image,
      0,
      0,
      _layer.size.width,
      _layer.size.height
    );

    fs.writeFileSync(`${buildDir}/${_currentEdition}`, canvas.toBuffer("image/png"));
    
  };
  
  
  const stackImagesLayers = async edition => {
    const layers = layersSetup(layersOrder);
    for (let i = 0; i < edition; i++) {
        layers.forEach(async (layer, index) => {        
            await drawLayer(layer, i);
        });
    }
  };

createDir();

stackImagesLayers(edition);