var net = require('net');
var events = require('events');
var util = require('util');
var sha256 = require('sha256');

var Host = function Host(host, port) {
  var _host = false, // Private variables
      _port = false,
      _version = false;
      
  Object.defineProperties(this, {
    'host': {
      get: function() { return _host; },
      enumerable: true
    },
    'port': {
      get: function() { return _port; },
      enumerable: true
    },
    'version': {
      get: function() { return _version; },
      enumerable: true
    }
  });
  
  if (Array.isArray(host)) {
    host = new Buffer(host);
  }
  _port = +port || this.defaultPort;
  
  if (typeof host === 'undefined') {
    _host = 'localhost';
    _version = 4;
    return this;
  } else if (typeof host === 'number') {
    // an IPv4 address, expressed as a little-endian 4-byte (32-bit) number
    // style of "pnSeed" array in Bitcoin reference client
    var buf = new Buffer(4);
    buf.writeInt32LE(host, 0);
    _host = Array.prototype.join.apply(buf, ['.']);
    _version = 4;
    return this;
  } else if (typeof host === 'string') {
    // DNS host name string
    // TODO: Resolve to IP, to ensure unique-ness
    if (host.indexOf(':') !== -1) {
      var pieces = host.split(':');
      _host = pieces[0];
      _port = pieces[1]; // Given "example.com:8080" as host, and "1234" as port, the "8080" takes priority
    } else {
      _host = host;
    }
    _version = (!net.isIP(host) || net.isIPv4(host))? 4 : 6;
    return this;
  } else if (Buffer.isBuffer(host)) {
    if (host.length == 4) {
      // IPv4 stored as bytes
      _host = Array.prototype.join.apply(host, ['.']);
      _version = 4;
      return this;
    } else if (host.slice(0, 12).toString('hex') != Host.IPV6_IPV4_PADDING.toString('hex')) {
      // IPv6
      _host = host.toString('hex').match(/(.{1,4})/g).join(':').replace(/\:(0{2,4})/g, ':0').replace(/^(0{2,4})/g, ':0');
      _version = 6;
      return this;
    } else {
      // IPv4 with padding in front
      _host = Array.prototype.join.apply(host.slice(12), ['.']);
      _version = 4;
      return this;
    }
  } else {
    throw new Error('Cound not instantiate peer; invalid parameter type: '+ typeof host);
  }
};
Host.prototype.IPV6_IPV4_PADDING = new Buffer([0,0,0,0,0,0,0,0,0,0,255,255]);
Host.prototype.defaultPort = 8333;

var Peer = exports.Peer = function Peer(host, port, magic) {
  events.EventEmitter.call(this);
  if (!(host instanceof Host)) {
    host = new Host(host, port);
  }
  Object.defineProperty(this, 'host', {
    enumerable: true,
    configurable: false,
    writable:false,
    value: host
  });
  if (typeof magic !== 'undefined') this.magicBytes = magic;
  return this;
};
util.inherits(Peer, events.EventEmitter);

Peer.prototype.MAX_RECEIVE_BUFFER = 10000;
Peer.prototype.magicBytes = 0xD9B4BEF9;

Peer.prototype.connect = function connect(socket) {
  this.inbound = new Buffer(this.MAX_RECEIVE_BUFFER);
  this.inboundCursor = 0;

  if (typeof socket === 'undefined' || !(socket instanceof net.Socket)) {
    socket = net.createConnection(this.host.port, this.host.host, this.handleConnect.bind(this));
  }
  Object.defineProperty(this, 'socket', {
    enumerable: false,
    configurable: false,
    writable:false,
    value: socket
  });
  this.socket.on('error', this.handleError.bind(this));
  this.socket.on('data', this.handleData.bind(this));
  this.socket.on('end', this.handleEnd.bind(this));
  this.socket.on('close', this.handleClose.bind(this));
  
  return this.socket;
};

Peer.prototype.disconnect = function disconnect() {
  this.socket.end(); // Inform the other end we're going away
};

Peer.prototype.getUUID = function getUUID() {
	return this.host.host+'~'+this.host.port;
}

Peer.prototype.handleConnect = function handleConnect() {
  this.emit('connect', {
    peer: this,
  });
};

Peer.prototype.handleEnd = function handleEnd() {
  this.emit('end', {
    peer: this,
  });
};

Peer.prototype.handleError = function handleError(data) {
  this.emit('error', {
    peer: this,
    error: data
  });
};

Peer.prototype.handleClose = function handleClose(had_error) {
	this.emit('close', {
	  peer: this,
	  had_error: had_error
	});
};

Peer.prototype.send = function send(data, callback) {
  if (!Buffer.isBuffer(data)) data = new Buffer(data);
  this.socket.write(data, null, callback);
};

Peer.prototype.handleData = function handleData(data) {
  // Add data to incoming buffer
  if (data.length + this.inboundCursor > this.inbound.length) {
    throw new Error('Peer exceeded max receiving buffer');
  }
  data.copy(this.inbound, this.inboundCursor);
  this.inboundCursor += data.length;
  
  if (this.inboundCursor < 20) return; // Can't process something less than 20 bytes in size
  
  // Split on magic bytes into message(s)
  var i = 0, endPoint = 0;
  //console.log('searching for messages in '+this.inboundCursor+' bytes');
  while (i < this.inboundCursor) {
    if (this.inbound.readUInt32LE(i) == this.magicBytes) {
      //console.log('found message start at '+i);
      var msgStart = i;
      if (this.inboundCursor > msgStart + 16) {
        var msgLen = this.inbound.readUInt32LE(msgStart + 16);
        //console.log('message is '+msgLen+' bytes long');
        if (this.inboundCursor >= msgStart + msgLen + 24) {
          // Complete message; parse it
          this.handleMessage(this.inbound.slice(msgStart, msgStart + msgLen + 24));
          endPoint = msgStart + msgLen + 24;
        }
        i += msgLen+24; // Skip to next message
      } else {
        i = this.inboundCursor; // Skip to end
      }
    } else {
      i++;
    }
  }
  
  // Done processing all found messages
  if (endPoint > 0) {
    //console.log('messaged parsed up to '+endPoint+', but cursor goes out to '+this.inboundCursor);
    this.inbound.copy(this.inbound, 0, endPoint, this.inboundCursor); // Copy from later in the buffer to earlier in the buffer
    this.inboundCursor -= endPoint;
    //console.log('removed '+endPoint+' bytes processed data, putting cursor to '+this.inboundCursor);
  }
};

Peer.prototype.handleMessage = function handleMessage(msg) {
  var msgLen = msg.readUInt32LE(16);

  // Get command
  var cmd = [];
  for (var j=0; j<12; j++) {
    var s = msg[4+j];
    if (s > 0) {
      cmd.push(String.fromCharCode(s));
    }
  }
  cmd = cmd.join('');
  
  var checksum = msg.readUInt32BE(20);
  if (msgLen > 0) {
    var payload = new Buffer(msgLen);
    msg.copy(payload, 0, 24);
    var checksumCalc = new Buffer(sha256.x2(payload, {asBytes:true}));
    if (checksum != checksumCalc.readUInt32BE(0)) {
      console.log('Supplied checksum of '+checksum.toString('hex')+' does not match calculated checksum of '+checksumCalc.toString('hex'));
    }
  } else {
    var payload = new Buffer(0);
  }
  
  this.emit('message', {
    peer: this,
    command: cmd,
    data: payload
  });
};