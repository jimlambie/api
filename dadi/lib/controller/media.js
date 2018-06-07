'use strict'

const acl = require('./../model/acl')
const Busboy = require('busboy')
const config = require('./../../../config')
const Controller = require('./index')
const help = require('./../help')
const imagesize = require('imagesize')
const jwt = require('jsonwebtoken')
const mediaModel = require('./../model/media')
const PassThrough = require('stream').PassThrough
const path = require('path')
const sha1 = require('sha1')
const StorageFactory = require('./../storage/factory')
const streamifier = require('streamifier')
const url = require('url')

const MediaController = function (model, server) {
  this.model = model
  this.server = server
}

MediaController.prototype = new Controller()

MediaController.prototype._formatDate = function (includeTime) {
  let d = new Date()
  let dateParts = [
    d.getFullYear(),
    ('0' + (d.getMonth() + 1)).slice(-2),
    ('0' + d.getDate()).slice(-2)
  ]

  if (includeTime) {
    dateParts.push(d.getHours())
    dateParts.push(d.getMinutes())
    dateParts.push(d.getSeconds())
  }

  return dateParts.join('/')
}

/**
 * Generates a JSON Web Token representing the specified object
 *
 * @param {Object} obj - a JSON object containing key:value pairs to be encoded into a token
 * @returns {string} JSON Web Token
 */
MediaController.prototype._signToken = function (obj) {
  return jwt.sign(
    obj,
    config.get('media.tokenSecret'),
    {
      expiresIn: obj.expiresIn || config.get('media.tokenExpiresIn')
    }
  )
}

/**
 *
 */
MediaController.prototype.count = function (req, res, next) {
  let path = url.parse(req.url, true)
  let query = this._prepareQuery(req, this.model)
  let parsedOptions = this._prepareQueryOptions(path.query, this.model.settings)

  if (parsedOptions.errors.length > 0) {
    return help.sendBackJSON(400, res, next)(null, parsedOptions)
  }

  this.model.count({
    client: req.dadiApiClient,
    options: parsedOptions.queryOptions,
    query
  }).then(response => {
    help.sendBackJSON(200, res, next)(null, response)
  }).catch(err => {
    help.sendBackJSON(200, res, next)(err)
  })
}

/**
 *
 */
MediaController.prototype.get = function (req, res, next) {
  let path = url.parse(req.url, true)
  let query = this._prepareQuery(req, this.model)
  let parsedOptions = this._prepareQueryOptions(path.query, this.model.settings)

  if (parsedOptions.errors.length > 0) {
    return help.sendBackJSON(400, res, next)(null, parsedOptions)
  }

  return this.model.get({
    client: req.dadiApiClient,
    options: parsedOptions.queryOptions,
    query,
    req
  }).then(response => {
    response.results = response.results.map(document => {
      return mediaModel.formatDocuments(document)
    })

    help.sendBackJSON(200, res, next)(null, response)
  }).catch(err => {
    help.sendBackJSON(500, res, next)(err)
  })
}

/**
 * Serve a media file from its location.
 */
MediaController.prototype.getFile = function (req, res, next, route) {
  let storageHandler = StorageFactory.create(req.params.filename)

  return storageHandler.get(req.params.filename, route, req, res, next)
}

/**
 * Generate a folder hierarchy for a file, based on a configuration property
 *
 * @param {string} fileName - the name of the file being uploaded
 */
MediaController.prototype.getPath = function (fileName) {
  let reSplitter

  switch (config.get('media.pathFormat')) {
    case 'sha1/4':
      reSplitter = new RegExp('.{1,4}', 'g')
      return sha1(fileName).match(reSplitter).join('/')
    case 'sha1/5':
      reSplitter = new RegExp('.{1,5}', 'g')
      return sha1(fileName).match(reSplitter).join('/')
    case 'sha1/8':
      reSplitter = new RegExp('.{1,8}', 'g')
      return sha1(fileName).match(reSplitter).join('/')
    case 'date':
      return this._formatDate()
    case 'datetime':
      return this._formatDate(true)
    default:
      return ''
  }
}

MediaController.prototype.put = function (req, res, next) {
  return this.post(req, res, next)
}

MediaController.prototype.post = function (req, res, next) {
  if (req.method.toLowerCase() === 'post') {
    let busboy = new Busboy({ headers: req.headers })
    this.data = []
    this.fileName = ''

    // Listen for event when Busboy finds a file to stream
    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
      if (this.tokenPayload) {
        if (this.tokenPayload.fileName && this.tokenPayload.fileName !== filename) {
          return next({
            statusCode: 400,
            name: 'Unexpected filename',
            message: 'Expected a file named "' + this.tokenPayload.fileName + '"'
          })
        }

        if (this.tokenPayload.mimetype && this.tokenPayload.mimetype !== mimetype) {
          return next({
            statusCode: 400,
            name: 'Unexpected mimetype',
            message: 'Expected a mimetype of "' + this.tokenPayload.mimetype + '"'
          })
        }
      }

      this.fileName = filename
      this.mimetype = mimetype

      file.on('data', (chunk) => {
        this.data.push(chunk)
      })

      file.on('end', () => {
        // console.log('Finished with ' + filename)
      })
    })

    // Listen for event when Busboy finds a non-file field
    busboy.on('field', (fieldname, val) => {
      // Do something with non-file field.
    })

    // Listen for event when Busboy is finished parsing the form
    busboy.on('finish', () => {
      let data = Buffer.concat(this.data)
      let stream = streamifier.createReadStream(data)

      let imageSizeStream = new PassThrough()
      let dataStream = new PassThrough()

      // duplicate the stream so we can use it for the imagesize() request and the
      // response. this saves requesting the same data a second time.
      stream.pipe(imageSizeStream)
      stream.pipe(dataStream)

      // get the image size and format
      imagesize(imageSizeStream, (err, imageInfo) => {
        if (err && err !== 'invalid') {
          console.log(err)
        }

        let fields = Object.keys(this.model.schema)
        let obj = {
          fileName: this.fileName
        }

        if (fields.includes('mimetype')) {
          obj.mimetype = this.mimetype
        }

        // Is `imageInfo` available?
        if (!err) {
          if (fields.includes('width')) {
            obj.width = imageInfo.width
          }

          if (fields.includes('height')) {
            obj.height = imageInfo.height
          }
        }

        let internals = {
          _apiVersion: req.url.split('/')[1],
          _createdAt: Date.now(),
          _createdBy: req.dadiApiClient && req.dadiApiClient.clientId
        }

        const callback = (err, response) => {
          response.results = response.results.map(document => {
            return mediaModel.formatDocuments(document)
          })

          help.sendBackJSON(201, res, next)(err, response)
        }

        return this.writeFile(req, this.fileName, this.mimetype, dataStream).then(result => {
          if (fields.includes('contentLength')) {
            obj.contentLength = result.contentLength
          }

          obj.path = result.path

          this.model.create(obj, internals, callback, req)
        })
      })
    })

    // Pipe the HTTP Request into Busboy
    req.pipe(busboy)
  } else {
    // if id is present in the url, then this is an update
    if (req.params.id || req.body.update) {
      let internals = {
        _lastModifiedAt: Date.now(),
        _lastModifiedBy: req.dadiApiClient && req.dadiApiClient.clientId
      }
      let query = {}
      let update = {}

      if (req.params.id) {
        query._id = req.params.id
        update = req.body
      } else {
        query = req.body.query
        update = req.body.update
      }

      this.model.update(query, update, internals, help.sendBackJSON(200, res, next), req)
    }
  }
}

MediaController.prototype.delete = function (req, res, next) {
  let query = req.params.id ? { _id: req.params.id } : req.body.query

  if (!query) return next()

  this.model.get({
    query, req
  }).then(results => {
    if (!results.results[0]) return next()

    let file = results.results[0]

    // remove physical file
    let storageHandler = StorageFactory.create(file.fileName)

    storageHandler.delete(file)
      .then(result => {
        this.model.delete({
          client: req.dadiApiClient,
          query,
          req
        }).then(({deletedCount, totalCount}) => {
          if (config.get('feedback')) {
            // Send 200 with JSON payload.
            return help.sendBackJSON(200, res, next)(null, {
              status: 'success',
              message: 'Document(s) deleted successfully',
              deleted: deletedCount,
              totalCount
            })
          }

          // Send 204 with no content.
          res.statusCode = 204
          res.end()
        }).catch(error => {
          return help.sendBackJSON(200, res, next)(error)
        })
      }).catch(err => {
        return next(err)
      })
  }).catch(err => {
    return next(err)
  })
}

MediaController.prototype.registerRoutes = function (route) {
  this.route = route

  // POST media/sign
  this.server.app.use(route + '/sign', (req, res, next) => {
    if (req.method && req.method.toLowerCase() !== 'post') {
      return next()
    }

    return acl.access.get(req.dadiApiClient, this.model.aclKey).then(access => {
      if (access.create !== true) {
        return help.sendBackJSON(null, res, next)(
          acl.createError(req.dadiApiClient)
        )
      }

      let token

      try {
        token = this._signToken(req.body)
      } catch (err) {
        let error = {
          name: 'ValidationError',
          message: err.message,
          statusCode: 400
        }

        return next(error)
      }

      help.sendBackJSON(200, res, next)(null, {
        url: `${route}/${token}`
      })
    })
  })

  this.server.app.use(route + '/count', (req, res, next) => {
    let method = req.method && req.method.toLowerCase()

    if (method !== 'get') {
      return next()
    }

    return this.count(req, res, next)
  })

  // POST media (upload)
  this.server.app.use(route + '/:token?', (req, res, next) => {
    let method = req.method && req.method.toLowerCase()

    if (method !== 'post' && method !== 'put') return next()

    let settings = this.model.settings

    if (settings.signUploads && !req.params.token) {
      let err = {
        name: 'NoTokenError',
        statusCode: 400
      }

      return next(err)
    }

    if (req.params.token) {
      jwt.verify(req.params.token, config.get('media.tokenSecret'), (err, payload) => {
        if (err) {
          if (err.name === 'TokenExpiredError') {
            err.statusCode = 400
          }

          return next(err)
        }

        this.tokenPayload = payload

        return this[method](req, res, next)
      })
    } else {
      return this[method](req, res, next)
    }
  })

  // GET media
  this.server.app.use(route, (req, res, next) => {
    let method = req.method && req.method.toLowerCase()

    if (method !== 'get') {
      return next()
    }

    if (!this[method]) {
      return next()
    }

    return this[method](req, res, next)
  })

  // GET media/filename
  this.server.app.use(route + '/:filename(.*png|.*jpg|.*jpeg|.*gif|.*bmp|.*tiff|.*pdf)', (req, res, next) => {
    return this.getFile(req, res, next, route)
  })

  // DELETE media
  this.server.app.use(`${route}/:id(${this.ID_PATTERN})`, (req, res, next) => {
    let method = req.method && req.method.toLowerCase()

    if (method !== 'delete') {
      return next()
    }

    if (!this[method]) {
      return next()
    }

    return this[method](req, res, next)
  })
}

/**
 * Save a file using the configured storage adapter
 *
 * @param {IncomingMessage} req - the HTTP request
 * @param {string} fileName - the name of the file being uploaded
 * @param {string} mimetype - the MIME type of the file being uploaded
 * @param {Object} stream - the stream containing the file being uploaded
 */
MediaController.prototype.writeFile = function (req, fileName, mimetype, stream) {
  return new Promise((resolve, reject) => {
    let folderPath = path.join(this.route, this.getPath(fileName))
    let storageHandler = StorageFactory.create(fileName)

    storageHandler.put(stream, folderPath).then((result) => {
      return resolve(result)
    }).catch((err) => {
      return reject(err)
    })
  })
}

module.exports = function (model, server) {
  return new MediaController(model, server)
}

module.exports.MediaController = MediaController
