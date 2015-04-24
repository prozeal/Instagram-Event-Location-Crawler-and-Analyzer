var request = require("request");
var bodyParser = require("body-parser");
var express = require("express");
var sockio = require("socket.io");
var crypto = require("crypto");
var r = require("rethinkdb");
var q = require("q");

var config = require("./config");


//initiate 
var app = express();
app.use(bodyParser.urlencoded({extended: true}));
app.use(express.static(__dirname + "/public"));

var api = "https://api.instagram.com/v1/";
var lastUpdate = 0;


//initiate socket io
var io = sockio.listen(app.listen(config.port), {log: false});
console.log("Server started on port " + config.port);


//define the subscribe function 

function subscribeToTag(tagName) {
  var params = {
    client_id: config.instagram.client,
    client_secret: config.instagram.secret,
    verify_token: config.instagram.verify,
    object: "tag", aspect: "media", object_id: tagName,
    callback_url: "http://" + config.host + "/publish/photo";
  };

  request.post({url: api + "subscriptions", form: params},
    function(err, response, body) {
      if (err) console.log("Failed to subscribe:", err)
      else console.log("Subscribed to tag:", tagName);
  });
}

function rtDBIni(tagName){
	r.connect(config.database).then(function(c) {
  		conn = c;
  		return r.dbCreate(config.database.db).run(conn);
	})
	.then(function() {
  		return r.tableCreate(tagName).run(conn);
	})
	.then(function() {
  		return q.all([
    		r.table(tagName).indexCreate("time").run(conn),
    		r.table(tagName).indexCreate("place", {geo: true}).run(conn)
  		]);
	})
	.error(function(err) {
  		if (err.msg.indexOf("already exists") == -1)
    	console.log(err);
	})
	.finally(function() {
  		r.table(tagName).changes().run(conn)
  		.then(function(cursor) {
    	cursor.each(function(err, item) {
      	if (item && item.new_val)
        	io.sockets.emit(tagName, item.new_val);
    	});
  	})
 	 .error(function(err) {
   		 console.log("Error:", err);
  });

  subscribeToTag();
});


//use to respond the the handshake by instagram API
app.get("/publish/photo", function(req, res) {
  if (req.param("hub.verify_token") == config.instagram.verify)
    res.send(req.param("hub.challenge"));
  else res.status(500).json({err: "Verify token incorrect"});
});


//use x-hub-signature to verify the source of the request
app.use("/publish/photo", bodyParser.json({
  verify: function(req, res, buf) {
    var hmac = crypto.createHmac("sha1", config.instagram.secret);
    var hash = hmac.update(buf).digest("hex");

    if (req.header("X-Hub-Signature") == hash)
      req.validOrigin = true;
  }
}));

//whenever the instagram API uses a post request to the server
app.post("/publish/photo", function(req, res) {
  if (!req.validOrigin) //check originn
    return res.status(500).json({err: "Invalid signature"});
  
  var update = req.body[0];
  res.json({success: true, kind: update.object});

  if (update.time - lastUpdate < 1) return; //check update time
  lastUpdate = update.time;
  
  var tagName = update.object_id;
  var path = api + "tags/" + update.object_id +
             "/media/recent?client_id=" + 
             config.instagram.client;

  var conn;
  r.connect(config.database).then(function(c) {
    conn = c;
    return r.table(tagName).insert( //insert into the corresponding database
      r.http(path)("data").merge(function(item) {
        return {
          time: r.now(),
          place: r.point(
            item("location")("longitude"),
            item("location")("latitude")).default(null)
        }
      })).run(conn)
  })
  .error(function(err) { console.log("Failure:", err); })
  .finally(function() {
    if (conn)
      conn.close();
  });
});

//when app get a post request from the below url, it will call the subscribe function and subscribe
//to-do : signature required. but for now it should be ok
app.post("/subscribe/:tag" , function(req,res){
  var tagName = req.params.tag;
  subscribeToTag(tagName);
});


}