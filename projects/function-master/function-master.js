
function objectValues(obj) {

    return Object.values(obj);
}

function keysToString(obj) {

    return Object.keys(obj).join(" ");

}

function valuesToString(obj) {
    var array = [];
    for (let key in obj) {
        if (typeof obj[key] === "string") {
            array.push(obj[key]);

        }
    }
    return array.join(" ");
}

function arrayOrObject(obj) {
    if (Array.isArray(obj)) {
        return "array";
    }

    return "object";
}

function capitalizeWord(string) {

    return string[0].toUpperCase() + string.slice(1);

}

function capitalizeAllWords(string) {
     var strings = string.split(' ');
    for (var i = 0; i < strings.length; i++) {
        strings[i] = strings[i].charAt(0).toUpperCase() + strings[i].slice(1);
    }
    return strings.join(" ");
}

function welcomeMessage(obj) {

    return "Welcome " + capitalizeWord(obj.name) + "!";
}

function profileInfo(obj) {

    return capitalizeWord(obj.name) + " is a " + capitalizeWord(obj.species);
}

function maybeNoises(obj) {
    if (obj.noises) {
        if (Array.isArray(obj.noises)) {
            if (obj.noises.length > 0) {
                return obj.noises.join(" ");
            }
        }
    }
    return 'there are no noises';
}

function hasWord(str, word) {
    var words = str.split(" ");
    for (var i = 0; i < words.length; i++) {
        if (word === words[i]) {

            return true;
        }
    }
    return false;
}

function addFriend(name, object) {

    object.friends.push(name);

    return object;


}

function isFriend(name, obj) {
    if (Object.keys(obj).includes("friends")) {
        let friends = obj.friends;
        // console.log(friends)
        for (let i = 0; i < friends.length; i++) {
            if (name === friends[i]) {
                return true
            }
        }
    }
    return false
}

function nonFriends(name, arr) {
    var names = [];
    for (var i = 0; i < arr.length; i++) {
        if (!isFriend(name, arr[i]) && arr[i].name !== name) {
            names.push(arr[i].name)

        }
    }

    return names;
}

function updateObject(obj, key, val) {
    obj[key] = val
    return obj
}

function removeProperties(obj, arr) {
    // get obj proprerties and compare them to the arr
    for (var i = 0; i < arr.length; i++) {
        if (obj.hasOwnProperty(arr[i])) {
            delete obj[arr[i]];
        }
    }
    return obj
}

function dedup(arr) {
    var num = [];
    for (var i = 0; i < arr.length; i++) {
        if (num.indexOf(arr[i]) === -1) {
            num.push(arr[i]);
        }
    }
    return num;
}

